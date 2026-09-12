import { parentPort, workerData } from "node:worker_threads";

const busy = new Int32Array(workerData.busy);
let announced = false;
for (;;) {
  // Deliberately busy tool-owned test worker. It never evaluates fixture or downstream code.
  if (!announced) {
    Atomics.store(busy, 0, 1);
    parentPort.postMessage("busy");
    announced = true;
  }
}
