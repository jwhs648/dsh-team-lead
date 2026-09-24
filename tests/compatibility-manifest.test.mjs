import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));

test("发布版本与锁文件根包保持一致", () => {
  assert.equal(lock.name, manifest.name);
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[""].name, manifest.name);
  assert.equal(lock.packages[""].version, manifest.version);
});

test("只声明已完成验收的 DSH rc.1 与 rc.2，不放行未知版本", () => {
  assert.equal(manifest.peerDependencies["@deepseek-ai/dsh"], "0.1.7-rc.1 || 0.1.7-rc.2");
});

test("依赖与内核兼容声明在锁文件中保持同步", () => {
  assert.deepEqual(lock.packages[""].dependencies, manifest.dependencies);
  assert.deepEqual(lock.packages[""].peerDependencies, manifest.peerDependencies);
});
