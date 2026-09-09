import { apiRequest } from './apiClient';

export interface EmployeeDocument {
  id: string;
  doc_type: string;
  file_name: string;
  checksum: string;
  size?: number | null;
  mime_type?: string | null;
  created_at?: string | null;
  [key: string]: unknown;
}

export async function listDocuments(employeeId: string): Promise<EmployeeDocument[]> {
  const { data } = await apiRequest<EmployeeDocument[] | { data: EmployeeDocument[] }>(
    `/api/v1/employees/${encodeURIComponent(employeeId)}/documents`,
    { method: 'GET' },
  );
  // Backend returns {data:[...]} which apiClient unwraps to the array already;
  // tolerate both envelope shapes.
  if (Array.isArray(data)) return data;
  const nested = (data as { data?: EmployeeDocument[] }).data;
  return Array.isArray(nested) ? nested : [];
}

export async function uploadDocument(
  employeeId: string,
  input: { doc_type: string; file_name: string; content_base64: string },
): Promise<EmployeeDocument> {
  const { data } = await apiRequest<EmployeeDocument>(
    `/api/v1/employees/${encodeURIComponent(employeeId)}/documents`,
    { method: 'POST', body: input },
  );
  return data;
}

export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Could not read file'));
        return;
      }
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}
