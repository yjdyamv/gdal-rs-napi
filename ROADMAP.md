# gdal-rs-napi 项目规划

> 本文是项目级路线图，覆盖定位、阶段目标、工程与质量、发布策略、风险。
> 状态基线：v0.1.0（已打 tag），103 项测试全绿，静态 GDAL 3.12.1 + PROJ 9.6.2，
> 148 个驱动，6 个平台产物。当前 `private: true`，**尚未发布到 npm**。

---

## 1. 现状盘点

### 已经成立的能力

| 维度 | 现状 |
|---|---|
| 运行时依赖 | 无。GDAL/PROJ 静态链接，数据文件随包（`assets/{gdal,proj}`） |
| 驱动 | 148 个（`gdal-src/all_drivers`），除 PDS 与 GEOS 外基本齐全 |
| 栅格 | 读写、窗口/像素访问、overview、统计、checksum/fillNoData/sieve、rasterize/polygonize/contourGenerate、buildVrt |
| 矢量 | 图层/字段/要素 CRUD、属性与空间过滤、游标、SQL、事务、fid/geom 列、capability |
| 程序 | `translate` / `warp` / `vectorTranslate` / `demProcess`，带 `onProgress` 与取消 |
| CRS | SpatialRef 全套读写、CoordinateTransform（点/数组/bounds/geometry）、identifyEpsg |
| 并发 | 进程级 `RwLock` 串行化 GDAL；`openThreadSafe()` 走共享锁，栅格读真并行 |
| 测试 | `node --test` 103 项，2.9k 行；Rust 侧纯函数单测；CI 六平台 + fmt/clippy |
| 发布 | tag → GitHub Release 挂 6 个自包含 tarball（含 os/cpu/libc 约束） |

### 需要正视的问题

1. **分发方式不是主流。** 用户必须 `npm install <github release url>`，无法 `npm install gdal-rs-napi`，也没有版本范围/镜像/审计链。
2. **文档与代码漂移。** `CHANGELOG.md` 的 Known gaps 仍写"geometries are not transformed"，但 `transformGeometry` 已实现且有测试通过。
3. ~~**`open` 失败信息丢失。**~~ 已修：加 `GDAL_OF_VERBOSE_ERROR` 后，失败会带上 GDAL 的原始原因（见 Phase 0）。
4. **代码集中。** `dataset.rs` 2108 行、`band.rs` 1573、`vector.rs` 1382，审阅与扩展成本在上升。
5. **musl 两个 leg 仍是 `experimental`**，`all_drivers` 的 vendored HDF5/netCDF/curl/libpq 是脆弱点。
6. **异步错误无 `err.code`**（`napi::Task` 限制），只能用消息前缀判断。
7. **GEOS 缺席是刻意的许可证决策** —— 已定案：改做**动态链接 GEOS 的可选变体构建**（默认包仍不带），见 [`docs/GEOS.md`](./docs/GEOS.md)。

---

## 2. 定位与目标

**一句话定位**：让 Node.js 用上 GDAL，而**不需要在主机上装 GDAL**——单包、自包含、可复现。

**目标用户**：服务端空间数据处理、COG/瓦片流水线、Serverless/容器、ETL 脚本。

**差异化**：对比 `node-gdal` / `gdal-async`（依赖系统 GDAL 或庞大的 prebuild 矩阵），本项目的核心卖点是**静态链接 + 数据内置 + 无宿主依赖**。

**1.0 的判定标准**（建议）：
- `npm install gdal-rs-napi` 在 6 个平台开箱即用，`diagnostics()` 全绿；
- 公开 API 冻结并有 semver 弃用策略；
- 关键缺口清单清零或明确标注为"设计取舍"；
- CI 全绿（musl 不再 experimental）；
- 有可查的 API 文档与至少 3 个可运行教程。

---

## 3. 阶段规划

### Phase 0 — 收口与发布（v0.1.x，1–2 周）

> 目标：把 v0.1.0 从"能用"变成"可依赖"。

- [ ] **上 npm**：`private: false`；采用 napi 标准布局——根包 + `optionalDependencies` 平台包（`@gdal-rs-napi/win32-x64-msvc` 等），保留 tarball 直装作为备选。
- [ ] **发布流水线**：tag → 构建 6 平台 → 发平台包 → 发根包；`npm publish --provenance`。
- [ ] **安装冒烟测试**：新增 CI job，在一个干净容器里 `npm install <tarball>` 后跑 `diagnostics()` + `drivers().length`，证明"零宿主依赖"的承诺成立。
- [ ] **审计 Known gaps**：逐条对代码核验，修掉文档漂移（`transformGeometry`、统计写回、批量读等）。
- [x] **修 `open` 错误消息**：已修 —— 失败原因是漏了 `GDAL_OF_VERBOSE_ERROR`：不设这个标志时 GDAL 静默返回空句柄，last-error 里什么都没有。加上标志即可，消息走原有错误路径。
- [ ] **CI 策略定案**：musl 要么转正（`experimental: false`），要么在 README 明确为"尽力而为"。
- [ ] 补 `SECURITY.md` / issue 模板 / 贡献指南。

**验收**：`npm view gdal-rs-napi version` 有值；全新机器 `npm i` 后第一次调用 `gdal.version()` 成功。

---

### Phase 1 — API 补全（v0.2，1–2 个月）

> 目标：把"已知缺口"从能力问题降级为取舍问题。
> **详细方案（含与 `gdal-async` 的逐项差距矩阵、API 冻结规则、补全顺序与依赖）见
> [`PHASE1.md`](./PHASE1.md)。** 以下只是摘要。

**错误与诊断**
- [ ] `open/openSync` 保留 GDAL 原始错误；错误对象补充 `err.gdalClass` / `err.gdalNumber`。
- [ ] 让异步方法也能带 `err.code`：若 `napi::Task` 无法承载，统一在 `Error` 上挂自定义字段。

**CRS / 几何**
- [ ] 暴露 `CoordTransformOptions`（指定 pipeline、精度目标）。
- [ ] 几何变换支持流式/批量（百万点不必调用方手动分块）；评估 `OGR_G_Transform` 的原地路径减少拷贝。

**栅格**
- [ ] 波段元数据写回：`setScale` / `setOffset` / `setUnitType` / `setDescription` / `setCategoryNames`。
- [ ] `setDefaultHistogram`（与已有 `setStatistics` 对齐）。
- [ ] `buildOverviews({ bands })` 的 per-band 限制：要么绕过 GTiff 约束，要么显式报"只支持全波段"。

**矢量**
- [ ] `FeatureCursor` 实现 `Symbol.asyncIterator`（现在只能手写 `read` 循环）。
- [ ] 列表字段写入（不再逗号拼接），与 `FieldDefinition` 对齐。
- [ ] 评估"每图层单读者"限制的缓解（副本/独立 dataset 句柄）。

**通用**
- [ ] `gdal.fs` 补齐常用 VSI 操作；明确 `/vsimem`、`/vsicurl`、`/vsizip` 的支持矩阵并写入文档。

**验收**：README 的 Known gaps 只剩"设计取舍"（GEOS、Intel macOS 等），没有"未实现"。

Phase 1 的主线（详见 `PHASE1.md`）：先做 **几何对象模型**（杠杆最大，且不受 GEOS 阻塞）、
**Driver/Dataset 对象模型**、**Feature/FieldDefn 对象模型**、**异步人体工学**
（异步 getter / `Symbol.asyncIterator`），再加 **`gdal.const` 枚举**与
**纯 JS 的 `gdal-rs-napi/compat` 兼容层**（让 `gdal-async` 用户改一行 import 即可迁移）。
MDArray、Node Streams、`calcAsync` 明确不做，记为设计取舍。

---

### Phase 2 — 性能与并发（v0.3，2–3 个月）

> 目标：把"异步只解放事件循环"升级为"可预测的并行"。

- [ ] **削弱全局锁**：调研 GDAL 3.10+ 的线程局部错误处理或自定义 `CPLErrorHandler`，让错误状态与锁解耦；先做 PoC 再决定是否改动 `runtime.rs`。
- [ ] **扩大 `openThreadSafe` 覆盖面**：现状限只读栅格；评估更多驱动与读路径。矢量的线程安全如实测不可行，就在文档里写死。
- [ ] **零拷贝**：`readPixels` 等回填到调用方提供的 `Buffer`/`TypedArray`，减少一次 memcpy。
- [ ] **基准进 CI**：`scripts/bench-parallel.mjs` 加回归阈值（或至少存档趋势），防止性能回退。
- [ ] **资源语义**：句柄/文件描述符/内存的上限与释放路径文档化；大栅格的流式读取模式统一。

**验收**：并发读吞吐随 `UV_THREADPOOL_SIZE` 线性增长的区间有实测数据支撑。

---

### Phase 3 — 生态与 1.0（v0.4 → v1.0，3–6 个月）

- [ ] **文档站**：typedoc 生成 API reference；README 拆分（快速开始 / 迁移 / FAQ）。
- [ ] **教程**：COG 生成流水线、Serverless 冷启动实测、并行瓦片读取、坐标系踩坑。
- [ ] **类型保障**：`binding.d.ts` 与运行时一致性测试（已有 `types.test.mjs`，扩展覆盖）。
- [ ] **API 冻结**：确定稳定面，写弃用策略与 `CHANGELOG` 规范（Keep a Changelog + semver）。
- [ ] **可选平台**：Intel macOS（`macos-13` leg）、Windows arm64；明确 32 位不支持。
- [ ] **许可与供应链**：`SBOM`（GDAL/PROJ/OpenSSL/HDF5/netCDF/libpq 清单）、license 白名单校验、provenance。
- [ ] 评估"按需裁剪驱动集"的构建选项，缓解 35MB `.node` / 12.7MB 包体。

---

## 4. 贯穿性工程项

| 领域 | 动作 |
|---|---|
| 代码结构 | 拆分 `dataset.rs` / `band.rs` / `vector.rs` 为子模块；统一 `raster_tools.rs` 的错误路径 |
| 测试 | 真实数据 fixtures 版本化；补失败路径与边界；目标覆盖率 > 80% |
| CI | 冷构建 180min 上限是隐患 → 缓存 + 并行；把 fmt/clippy/单测固定在 linux-x64 |
| 文档 | 每个公开 API 的 doc comment 即文档源；Known gaps 与代码在 CI 里做一致性检查（可行的话） |
| 构建 | 增量构建与 `assets` staging 的确定性；三平台工具链 pin |

---

## 5. 风险登记

| 风险 | 影响 | 应对 |
|---|---|---|
| GEOS 缺席 | OGR 空间谓词不可用 | **已定案**：默认包继续排除；提供**动态链接 GEOS** 的可选变体构建并随包发共享库（`docs/GEOS.md`） |
| musl + all_drivers | 构建脆弱、易碎 leg | 容器原生构建已见效；考虑拆出精简 musl 变体 |
| 上游 `gdal` 0.19 / `gdal-sys` 0.12 漂移 | API 破坏、GDAL 升级受限 | 锁定版本 + 定期跟进；抽象层隔离 |
| 全局锁 | 并发上限、错误状态耦合 | Phase 2 的 PoC；实在不行明确写进文档 |
| 包体与构建时长 | 用户体验、CI 成本 | 按需驱动、LTO 调优、缓存 |
| 许可证 | static linking 的传染性 | GEOS 走**动态链接**变体以履行 LGPL（`docs/GEOS.md`），而非静态链接 + 可重链接产物；新增依赖需过 license 门禁 |

---

## 6. 里程碑一览

| 版本 | 主题 | 关键交付 | 建议周期 |
|---|---|---|---|
| v0.1.x | 收口与发布 | npm 上架、安装冒烟、open 错误、文档校准 | 1–2 周 |
| v0.2 | API 补全 | 缺口清零、异步 iterator、元数据写回、错误码统一 | 1–2 月 |
| v0.3 | 性能与并发 | 锁优化 PoC、零拷贝、基准进 CI | 2–3 月 |
| v0.4 | 生态 | 文档站、教程、类型一致性、SBOM | 2–3 月 |
| v1.0 | 稳定 | API 冻结、弃用策略、CI 全绿 | 达成即发 |

---

## 7. 成功指标

- **可用性**：6 平台 `npm i` 成功率 100%；首次调用成功率 100%。
- **稳定性**：CI 主分支连续 30 天全绿；无 P0 issue 堆积。
- **性能**：`openThreadSafe` 并发读相对串行有可量化加速；基准无回退。
- **体验**：失败能拿到 GDAL 原始原因；公开 API 100% 有类型与文档。
- **生态**：npm 周下载、issue 响应时长、教程可复现率。
