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

test("版本为 1.2.0", () => {
  assert.equal(manifest.version, "1.2.0");
});

test("插件元数据：locale 与 cordis.patch.yml 经 exports 可解析（与宿主读取方式一致）", async () => {
  assert.equal(manifest.exports["./locale/*.json"], "./locale/*.json");
  assert.equal(manifest.exports["./cordis.patch.yml"], "./cordis.patch.yml");
  assert.equal(manifest.exports["./package.json"], "./package.json");
  for (const language of ["en", "zh"]) {
    const resolved = import.meta.resolve(`${manifest.name}/locale/${language}.json`);
    const parsed = JSON.parse(await readFile(new URL(resolved), "utf8"));
    for (const field of ["title", "description"]) {
      assert.equal(typeof parsed.meta[field], "string", `${language}.${field}`);
      assert.notEqual(parsed.meta[field].trim(), "", `${language}.${field}`);
    }
  }
  const patch = import.meta.resolve(`${manifest.name}/cordis.patch.yml`);
  assert.ok(patch.endsWith("/cordis.patch.yml"));
});

test("图标：相对路径 SVG，位于包内且不超过 256 KiB", async () => {
  assert.equal(manifest.icon, "./icon.svg");
  const bytes = await readFile(new URL(`../${manifest.icon.slice(2)}`, import.meta.url));
  assert.ok(bytes.length > 0 && bytes.length <= 256 * 1024);
  assert.match(bytes.toString("utf8"), /^<svg [^>]*viewBox="0 0 36 36"/);
});

test("bundle 补丁插入 member-model，保持 inherit 并开启 requireArm", async () => {
  const text = await readFile(new URL("../cordis.patch.yml", import.meta.url), "utf8");
  assert.match(text, /- id: member-model\n\s+name: member-model\n\s+config:\n\s+inherit: true\n\s+requireArm: true\n/);
});

test("配置默认值：inherit、requireArm 开启，建队员工具名为 spawn_teammate", async () => {
  const { Config } = await import("../index.js");
  const config = Config({});
  // volatile 字段由 schemastery 包成 { get() } 以便热更新读取实时值。
  const read = (field) => (typeof field?.get === "function" ? field.get() : field);
  assert.equal(read(config.inherit), true);
  assert.equal(read(config.requireArm), true);
  assert.equal(read(config.teammateTool), "spawn_teammate");
  assert.equal(read(config.provider), "");
  assert.equal(read(config.model), "");
});
