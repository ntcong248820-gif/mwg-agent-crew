#!/usr/bin/env node
/**
 * Chạy `codexRunApp` đúng như entry codex-run.mjs từng chạy nó trước 2.0.4.
 *
 * Entry thật giờ từ chối `--mode app` cho Codex, nên đường app không còn cửa
 * vào từ CLI. Hàm vẫn còn trong source tới khi xoá hẳn, và các lần kiểm của nó
 * (cờ bị từ chối, guard resume, cancel khi quá hạn, cuộc đua lúc dispatch) vẫn
 * phải đúng chừng nào nó còn đó. Driver này là cửa riêng cho test: cùng parser,
 * cùng mã thoát 0/1/3, cùng JSON in ra -- trừ phần ghi manifest, vì một job
 * Codex app mới không còn vào được manifest nào.
 */
import { codexRunApp, needsHuman, parseArgv } from "../../scripts/codex-run.mjs";

try {
  const opts = parseArgv(process.argv.slice(2));
  if (opts.manifest || opts.job) {
    throw new Error("driver không ghi manifest; job Codex app không còn được dispatch từ sổ");
  }
  if (opts.mode !== "app") throw new Error("driver chỉ chạy --mode app");
  const result = await codexRunApp(opts);
  if (result.runtimeVerdict) {
    console.error(`codex-run: the runtime disagreed with the evidence (${result.runtimeVerdict})`);
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(needsHuman(result) ? 3 : 0);
} catch (err) {
  console.error(`codex-run: ${err.message}`);
  process.exit(1);
}
