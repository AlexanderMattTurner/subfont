import { parentPort } from 'worker_threads';
import * as fontverter from 'fontverter';

interface ConvertMessage {
  taskId: number;
  buffer: Uint8Array | Buffer;
  targetFormat: string;
  sourceFormat?: string;
}

if (!parentPort) {
  throw new Error('fontConverterWorker must be run as a worker thread');
}

const port = parentPort;

port.on('message', async (msg: ConvertMessage) => {
  try {
    const buffer = Buffer.from(msg.buffer);
    const result = await fontverter.convert(
      buffer,
      msg.targetFormat,
      msg.sourceFormat
    );
    port.postMessage({ type: 'result', taskId: msg.taskId, buffer: result });
  } catch (rawErr) {
    const err = rawErr as Error;
    port.postMessage({ type: 'error', taskId: msg.taskId, error: err.message });
  }
});
