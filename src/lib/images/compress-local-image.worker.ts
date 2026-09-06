/// <reference lib="webworker" />

import {
  compressImageOnce,
  ImageCompressionCapabilityError,
} from "./compression-core";
import type {
  CompressionWorkerRequest,
  CompressionWorkerResponse,
} from "./worker-protocol";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

workerScope.addEventListener(
  "message",
  async (event: MessageEvent<CompressionWorkerRequest>) => {
    const { id, file, quality } = event.data;
    let response: CompressionWorkerResponse;
    try {
      const result = await compressImageOnce(file, quality);
      response =
        result.status === "compressed"
          ? { id, status: "compressed", file: result.file }
          : { id, status: "unchanged" };
    } catch (error) {
      response =
        error instanceof ImageCompressionCapabilityError
          ? { id, status: "unsupported" }
          : { id, status: "unchanged" };
    }
    workerScope.postMessage(response);
  },
);
