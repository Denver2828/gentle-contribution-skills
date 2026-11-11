// The body of a publication attempt.
//
// The publisher runs here, in a terminable worker, for the same reason checks
// do: a publisher that hangs, throws or exits must be observable from outside
// rather than take the process with it. It receives the receipt and nothing
// else, and returns whatever it did.

import { workerData, parentPort } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

try {
  const module = await import(pathToFileURL(workerData.publisherModule).href);
  const publisher = module.default;

  if (publisher === undefined || typeof publisher.publish !== 'function') {
    parentPort.postMessage({ ok: false, error: { name: 'PublisherError', message: `${workerData.publisherModule} exports no publish function` } });
  } else {
    const outcome = await publisher.publish({ receipt: workerData.receipt });
    parentPort.postMessage({ ok: true, outcome });
  }
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: { name: error?.name ?? 'Error', message: error?.message ?? String(error) },
  });
}
