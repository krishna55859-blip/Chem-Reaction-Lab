/**
 * Chemistry Reaction Lab - PubChem PUG REST API Service
 * Handles search-on-demand workflow and integrates with Supabase.
 */

import { createClient } from '@supabase/supabase-js';

// Initialize Supabase Client (Replace with your actual Lovable/Supabase environment variables if different)
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export interface ChemicalRecord {
  id?: number;
  pubchem_cid: number;
  name: string;
  formula: string | null;
  molecular_weight: number | null;
  smiles: string | null;
  cas_number: string | null;
}

const PUBCHEM_BASE_URL = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug';

/**
 * Step 1: Fetch chemical properties from PubChem using its Chemical ID (CID)
 */
async function fetchPubChemProperties(cid: number): Promise<Partial<ChemicalRecord> | null> {
  try {
    const url = `${PUBCHEM_BASE_URL}/compound/cid/${cid}/property/MolecularFormula,MolecularWeight,CanonicalSMILES/JSON`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`PubChem property fetch failed for CID ${cid}`);
    
    const data = await response.json();
    const props = data.PropertyTable?.Properties?.[0];
    
    if (!props) return null;
    
    return {
      pubchem_cid: cid,
      formula: props.MolecularFormula || null,
      molecular_weight: props.MolecularWeight ? parseFloat(props.MolecularWeight) : null,
      smiles: props.CanonicalSMILES || null,
    };
  } catch (error) {
    console.error('Error fetching PubChem properties:', error);
    return null;
  }
}

/**
 * Step 2: Fetch synonyms/CAS number from PubChem for a specific CID
 */
async function fetchPubChemSynonyms(cid: number): Promise<string[]> {
  try {
    const url = `${PUBCHEM_BASE_URL}/compound/cid/${cid}/synonyms/JSON`;
    const response = await fetch(url);
    if (!response.ok) return [];
    
    const data = await response.json();
    return data.InformationList?.Information?.[0]?.Synonym || [];
  } catch {
    return [];
  }
}

/**
 * Main Search Workflow: Search Local Database -> Fallback to PubChem API -> Cache to Local DB
 * @param searchName The name of the chemical to search for (e.g., "Aspirin", "Water")
 */
export async function searchAndCacheChemical(searchName: string): Promise<ChemicalRecord | null> {
  const normalizedQuery = searchName.trim().toLowerCase();
  if (!normalizedQuery) return null;

  // 1. Check local Supabase database first
  const { data: localChemical, error: localError } = await supabase
    .from('chemicals')
    .select('*')
    .ilike('name', normalizedQuery)
    .single();

  if (localChemical) {
    console.log('Found chemical in local cache:', localChemical.name);
    return localChemical as ChemicalRecord;
  }

  // 2. If not found locally, query PubChem PUG REST API by name to get the CID
  console.log(`Chemical "${searchName}" not found locally. Querying PubChem API...`);
  try {
    const searchUrl = `${PUBCHEM_BASE_URL}/compound/name/${encodeURIComponent(normalizedQuery)}/cids/JSON`;
    const searchResponse = await fetch(searchUrl);
    
    if (!searchResponse.ok) {
      console.warn(`Chemical "${searchName}" not found on PubChem.`);
      return null;
    }
    
    const searchData = await searchResponse.json();
    const cid = searchData.IdentifierList?.CID?.[0];
    
    if (!cid) return null;

    // 3. Double check if this exact CID already exists locally under a different synonym name
    const { data: cidCheck } = await supabase
      .from('chemicals')
      .select('*')
      .eq('pubchem_cid', cid)
      .single();

    if (cidCheck) {
      return cidCheck as ChemicalRecord;
    }

    // 4. Fetch complete properties and synonyms from PubChem using the CID
    const [properties, synonyms] = await Promise.all([
      fetchPubChemProperties(cid),
      fetchPubChemSynonyms(cid)
    ]);

    if (!properties) return null;

    // Extract potential CAS Number from synonyms (looks like 123-45-6)
    const casRegex = /^\d{2,7}-\d{2}-\d$/;
    const casNumber = synonyms.find(syn => casRegex.test(syn)) || null;

    // 5. Construct the record to save into Supabase
    const newChemical: Omit<ChemicalRecord, 'id'> = {
      pubchem_cid: cid,
      name: searchName, // Retain user's searched name as primary text
      formula: properties.formula || null,
      molecular_weight: properties.molecular_weight || null,
      smiles: properties.smiles || null,
      cas_number: casNumber,
    };

    // 6. Insert into Supabase 'chemicals' table to cache it for the next user
    const { data: cachedChemical, error: insertError } = await supabase
      .from('chemicals')
      .insert([newChemical])
      .select('*')
      .single();

    if (insertError) {
      console.error('Failed to cache chemical to Supabase:', insertError.message);
      return null;
    }

    // 7. Optional: Bulk insert synonyms asynchronously into 'chemical_synonyms' table
    if (synonyms.length > 0 && cachedChemical) {
      const topSynonyms = synonyms.slice(0, 10).map(syn => ({
        chemical_id: cachedChemical.id,
        synonym: syn
      }));
      await supabase.from('chemical_synonyms').insert(topSynonyms);
    }

    console.log('Successfully cached new chemical from PubChem:', cachedChemical.name);
    return cachedChemical as ChemicalRecord;

  } catch (error) {
    console.error('Error during PubChem search-and-cache workflow:', error);
    return null;
  }
}
