/**
 * Piscina worker handler for font format conversion.
 *
 * Each worker thread loads its own wawoff2 WASM instance via fontverter,
 * enabling safe parallel woff2 compression — wawoff2's shared WASM
 * instance corrupts memory under concurrent use within a single thread.
 */

import * as fontverter from 'fontverter';

interface ConvertTask {
  buffer: Uint8Array | Buffer;
  targetFormat: string;
  sourceFormat?: string;
}

async function convertTask(task: ConvertTask): Promise<Uint8Array> {
  // Structured clone delivers Uint8Array on the worker side; wrap so
  // fontverter sees the Buffer it expects. The host wraps the response
  // in Buffer.from on its end — wrapping here would duplicate work
  // since structured clone copies bytes and strips the Buffer prototype
  // on every transfer.
  const buffer = Buffer.from(task.buffer);
  return await fontverter.convert(buffer, task.targetFormat, task.sourceFormat);
}

export = convertTask;
