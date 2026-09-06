export interface CompressionWorkerRequest {
  id: string;
  file: File;
  quality: number;
}

export type CompressionWorkerResponse =
  | { id: string; status: "compressed"; file: File }
  | { id: string; status: "unchanged" }
  | { id: string; status: "unsupported" };
