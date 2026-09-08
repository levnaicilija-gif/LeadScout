export type EmployerType = 'end_client' | 'staffing_agency' | 'epc_contractor' | 'unknown';
export type Extracted = {
  company: string; person?: { name: string; title: string; quote: string };
  project?: { name?: string; location?: string; value?: string; phase?: string; start?: string; end?: string };
  trades: string[]; companies_mentioned?: { name: string; role: string; start?: string }[];
};
export const RFBT_TRADES = ['painter', 'blaster', 'welder', 'pipefitter', 'fitter', 'ndt', 'rope access', 'wind technician', 'electrician', 'scaffolder'];
export const SUPPLY_COUNTRIES = ['Denmark', 'Netherlands', 'Norway', 'Sweden', 'Germany', 'Belgium', 'United Kingdom', 'Spain'];
