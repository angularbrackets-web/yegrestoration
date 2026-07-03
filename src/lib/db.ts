import { neon } from '@neondatabase/serverless';

export type Lead = {
  id: number;
  name: string;
  phone: string;
  email: string | null;
  service: string;
  message: string | null;
  status: 'new' | 'read' | 'replied';
  replied_at: string | null;
  created_at: string;
};

export function getDb() {
  const url = process.env.DATABASE_URL ?? import.meta.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not configured');
  return neon(url);
}

export const SERVICE_LABELS: Record<string, string> = {
  water: 'Water Damage Restoration',
  fire: 'Fire Damage Restoration',
  mold: 'Mold Removal',
  storm: 'Storm Damage Repair',
  sewage: 'Sewage Cleanup',
  construction: 'Construction Services',
  contents: 'Contents Restoration',
  biohazard: 'Biohazard Cleaning',
  asbestos: 'Asbestos Abatement',
  other: 'Other Emergency',
};
