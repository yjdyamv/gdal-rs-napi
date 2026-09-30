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
| 驱动 | 148 个（`gdal-src/all_drivers`），除 PDS 外基本齐全；GEOS 也静态链入（见 §5 风险表） |
| 栅格 | 读写、窗口/像素访问、overview、统计、checksum/fillNoData/sieve、rasterize/polygonize/contourGenerate、buildVrt |
| 矢量 | 图层/字段/要素 CRUD、属性与空间过滤、游标、SQL、事务、fid/geom 列、capability |
| 程序 | `translate` / `warp` / `vectorTranslate` / `demProcess`，带 `onProgress` 与取消 |
| CRS | SpatialRef 全套读写、CoordinateTransform（点/数组/bounds/geometry）、identifyEpsg |
| 并发 | 进程级 `RwLock` 串行化 GDAL；`openThreadSafe()` 走共享锁，栅格读与只读访问器真并行 |
| 测试 | `node --test` 103 项，2.9k 行；Rust 侧纯函数单测；CI 六平台 + fmt/clippy |
| 发布 | tag → GitHub Release 挂 6 个自包含 tarball（含 os/cpu/libc 约束） |

### 需要正视的问题

1. **分发方式不是主流。** 用户必须 `npm install <github release url>`，无法 `npm install gdal-rs-napi`，也没有版本范围/镜像/审计链。
2. **文档与代码漂移。** `CHANGELOG.md` 的 Known gaps 仍写"geometries are not transformed"，但 `transformGeometry` 已实现且有测试通过。
3. ~~**`open` 失败信息丢失。**~~ 已修：加 `GDAL_OF_VERBOSE_ERROR` 后，失败会带上 GDAL 的原始原因（见 Phase 0）。
4. **代码集中。** `dataset.rs` 2108 行、`band.rs` 1573、`vector.rs` 1382，审阅与扩展成本在上升。
5. **musl 两个 leg 仍是 `experimental`**，`all_drivers` 的 vendored HDF5/netCDF/curl/libpq 是脆弱点。
6. ~~**异步错误无 `err.code`**。~~ 已解决：外壳把消息前缀提回 `err.code`，与同步路径一致（令牌仍留在消息里，两种匹配方式都成立）。
7. **GEOS 缺席是刻意的许可证决策** —— 已定案改为**自行构建 + 静态链接**（与 GDAL/PROJ 同一条路，默认就有），分发仍是单个自包含产物；见 [`docs/GEOS.md`](./docs/GEOS.md)。

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

- [ ] **上 npm** —— **刻意推迟**：接口尚未打磨完，包保持 `private`。布局与打包已经就位（`scripts/pack-packages.mjs` 产出 napi 标准形状的根包 + `gdal-rs-napi-<platform>` 平台包；`binding.js` 本来就是按 `optionalDependencies` 那套生成的），`npm publish` 那一步不做——也还没有做。届时需要：`private: false`、在根包写出六个 `optionalDependencies`、加一个 tag 触发的发布 job（平台包先、根包后，`--provenance`）。
- [ ] **发布流水线**：tag → 构建 6 平台 → GH Release 附自包含 tarball + LGPL 材料（**已在跑**）；npm 发布那半段同上，未做。
- [x] **安装冒烟测试**：`npm run smoke` —— 在一个空目录里 `npm install <tarball>`，再跑一个消费者程序（`diagnostics()`、`drivers().length`、GEOS 谓词、栅格往返）。CI 每个平台都跑，而 CI runner 正是"干净机器"本身。
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
- [x] `open/openSync` 保留 GDAL 原始错误（补 `GDAL_OF_VERBOSE_ERROR`，见 Phase 0）。
- [x] 错误对象补充 `err.gdalClass` / `err.gdalNumber` —— **记为取舍**（不是"没做"，是"决定不做"）。napi 的 `Error` 只能携带 `code`/`cause`，而且它只给**异步**路径（`Task` 的拒绝）留了外壳可插手的位置；要让*每个同步错误*也多两个字段，就得在外壳里包住整个导出面（含构造器与访问器），而那正是不做这种包装、把 `async-methods.js` 写成名单的理由。信息并没有丢：`err.message` 的前缀就是 `[CPLErr=3 #1]`（class 与 number），`lastError()` 也照样返回 `{class, number, message}`。写入 `docs/API-STABILITY.md`。
- [x] 让异步方法也能带 `err.code`：`napi::Task` 无法承载，所以由外壳从消息前缀提取成字段（`async-methods.js` 列出要包的方法，并有测试对照 `binding.d.ts` 防止漏包）。

**CRS / 几何**
- [x] 暴露 `CoordTransformOptions`：`new CoordinateTransform(from, to, { pipeline, reverse, accuracy, ballpark, areaOfInterest })`。附带一个实测发现：具名管线拿到的坐标是**源 CRS 的 authority 顺序**，所以按本 API 顺序写的管线要自己 `axisswap`。
- [x] 几何变换支持流式/批量：`CoordinateTransform.transformPoints` 把点数组搬到线程池上（同步版更名 `transformPointsSync`），百万点不必调用方手动分块；`OGR_G_Transform` 的原地路径**已评估、不采纳** —— `Geometry` 是值类型，省下的只是一次克隆（理由见 PHASE1 WS-4）。

**栅格**
- [x] 波段元数据写回：`setScale` / `setOffset` / `setUnitType` / `setDescription` / `setCategoryNames`（见 PHASE1「WS-6 波段元数据写回」；唯一的不对称是 `scale`/`offset` 没有"清除"，因为 GDAL 的 setter 只收数字）。
- [x] `setDefaultHistogram`（与已有 `setStatistics` 对齐）—— 同样见 PHASE1「WS-6 直方图写回」。
- [x] 调色板：`colorTable` / `paletteInterpretation` / `setColorTable(entries, interpretation?)`。分量沿用 GDAL 自己的 `c1`..`c4`，且是**无符号 16 位**——`gdal` crate 按 `i16` 读，所以 65000 会以 -536 进来，边界处转回，两头都有 Rust 测试；含义由 `paletteInterpretation`（`Gray`/`Rgba`/`Cmyk`/`Hls`）给出。能存多少是驱动的事，实测四种各不相同：MEM 与 VRT 全 16 位无损（VRT 把有符号值写进自己的 XML），GTiff 的 TIFF 色表只有 8 位 × 256 项、没有 alpha，只读句柄不报错而是落到 `.aux.xml`（与 `setStatistics` 同一条路）。
- [x] 掩膜波段：`band.mask`（掩膜就当成另一条 `RasterBand`，读走共享锁，线程安全数据集上也一样）、`band.maskFlags`（`allValid`/`perDataset`/`alpha`/`noData` 四个布尔——GDAL 的标志位不互斥）、`band.createMask(perDataset?)`。GDAL 无论文件里有没有掩膜都会给一条：没有时是"全有效"的隐式波段（处处 255，且**写不进去**，GDAL 报 "attempt to write to an all-valid implicit mask band"），用 `maskFlags.allValid` 区分。掩膜也可以是**派生**的（alpha 通道或 no-data 值），正是 `alpha`/`noData` 的含义。重复创建是驱动自己的答案而不是这里的规则：GTiff 第二次就拒绝（"already an internal mask band"）。
- [x] `buildOverviews({ bands })` 的 per-band 限制：**不绕过，由 GDAL 显式报错** —— 本构建里唯一可写的 overview 驱动是 GTiff，它只接受全波段，消息就是 "Generation of overviews in TIFF currently only supported when operating on all bands"；`bands` 照常透传（给将来接受子集的驱动），并有测试钉住 GTiff 的拒绝。

**矢量**
- [x] `FeatureCursor` 实现 `Symbol.asyncIterator`：`for await (const feature of layer.openCursor())`，由外壳加上，读的是同一个 `read()`。
- [x] 列表字段写入 —— **核实后决定不改**。实测：GeoJSON 与 SQLite 真能存列表并读回数组；GPKG 接受声明却降级成标量列（列表值落成 GDAL 内部的 `(2:a,b)`）；FlatGeobuf 收下字段、拒绝写要素。所以推断继续写逗号连接的 `String` —— 那是唯一四种都成立的形态，而且它就是那个值。四种行为有测试钉住。
- [x] 评估"每图层单读者"限制的缓解 —— 缓解就是**再开一个 dataset 句柄**（实测：两个句柄各自按批推进、各自看完整层）；`layer.getFeature(fid)` 是随机访问、不移动位置。顺带修掉一个真问题：`featuresSync()` / `features()` 此前跟在游标后面只返回**尾部**，现在先倒带，整层读取名副其实。详见 PHASE1（WS-3 之后的评估段）。

**通用**
- [x] `gdal.fs` 补齐常用 VSI 操作（`rename` / `copyFile` / `glob` / `mkdirRecursive` / `rmdirRecursive` / `isLocal` / `diskFreeSpace`）；`/vsimem`、`/vsizip`、`/vsicurl` 的支持矩阵已写作 README 的表格 —— 读处处可用，`/vsizip` 能**加**条目但不能覆盖/删除/改名，`/vsicurl` 拒一切写入。

**验收**：README 的 Known gaps 只剩"设计取舍"（GEOS、Intel macOS 等），没有"未实现"。

Phase 1 的主线（详见 `PHASE1.md`）：先做 **几何对象模型**（杠杆最大，且不受 GEOS 阻塞）、
**Driver/Dataset 对象模型**、**Feature/FieldDefn 对象模型**、**异步人体工学**
（异步 getter / `Symbol.asyncIterator`），再加 **`gdal.const` 枚举**与
**纯 JS 的 `gdal-rs-napi/compat` 兼容层**（让 `gdal-async` 用户改一行 import 即可迁移）。
MDArray、Node Streams、`calcAsync` 明确不做，记为设计取舍。

---

### Phase 2 — 性能与并发（v0.3，2–3 个月）

> 目标：把"异步只解放事件循环"升级为"可预测的并行"。

- [x] **削弱全局锁**：PoC 的结论是**前提已经过时** —— GDAL ≥3.10 的 last-error 是线程局部的（每线程一个 `CPLErrorContext`），`OGRSpatialReference` 的 PROJ context 来自 `OSRGetProjTLSContext()`，GEOS 则是每次调用一个 context。于是**无数据集**的调用（CRS / `CoordinateTransform`、几何 / GEOS、`gdal.fs`）改走共享锁、真正并发；数据集与进程级配置仍走独占（同一个 dataset 跨线程不安全，部分驱动本身也不安全）。实测 4 个并发 40 万点变换：**1.03x → 2.93x**。证据写进 `src/runtime.rs`，前提由 Rust 测试 `gdals_last_error_is_thread_local` 钉住，收益由 `scripts/bench-parallel.mjs` 量出。
- [ ] **扩大 `openThreadSafe` 覆盖面**：现状限只读栅格；评估更多驱动与读路径。矢量的线程安全如实测不可行，就在文档里写死。（上一项 PoC 的补充结论：把**普通**数据集也放成并发，不能只靠"错误状态已解耦"就放开，得经 GDAL 的 `GDALGetThreadSafeDataset` 或逐驱动判断。）读路径本身已放宽一格：只读访问器（尺寸、geotransform、projection、元数据、band/overview 查询）与 `checksum` 都走共享锁，判据是"是否只查看已有状态、是否会让 GDAL 把算出来的结果存下"；实测 4 并发读中夹 39 轮访问器：**22.2 ms 串行 vs 8.1 ms 并发（2.75x）**。数据集之外的**模块级自省**（`version` / `info` / `diagnostics` / `lastError` / `epsgToWkt`、`geometry*`、`drivers()` / `driver(name)` 及其 `Driver` 方法）也已并到共享锁——它们本来就不含数据集；同一把锁上实测 146 轮自省：**空闲 79.5 ms vs 四个变换在飞时 90.7 ms（1.14x，若排队应为 2.34x）**。剩下的仍是写、矢量侧与 programs；唯一的例外读是 `config.get`，它必须留在独占侧——`CPLGetConfigOption` 返回指向配置表内部的指针并随即放手，并发的 `config.set` 会 use-after-free。
- [x] **零拷贝**：`readPixels` / `readAs` 的 options 增加 `into: Buffer`，GDAL 直接写进调用方内存（`GDALRasterIOEx`，传裸指针而不是 `&mut [T]`——JS 的 `Buffer` 不保证对齐），**不分配、不拷贝**；长度必须精确匹配，返回值就是传入的那个对象（同步与异步都是）。写路径拒绝 `into` 而不是忽略。跨距/子区域填充（gdal-async 的 `buffer_width`/`line_space`）**不做**：那要自己铺开 RasterIO 的行跨距，等真有需求再说。
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
| GEOS | OGR 空间谓词此前不可用；现改为链入，但它是 LGPL-2.1 | **已定案**：`geos-src` 自行构建 + **静态链接**，与 GDAL/PROJ 同路，分发仍是单个自包含产物；发布需附 §6 材料（`docs/GEOS.md`） |
| musl + all_drivers | 构建脆弱、易碎 leg | 容器原生构建已见效；考虑拆出精简 musl 变体 |
| 上游 `gdal` 0.19 / `gdal-sys` 0.12 漂移 | API 破坏、GDAL 升级受限 | 锁定版本 + 定期跟进；抽象层隔离 |
| 全局锁 | 并发上限、错误状态耦合 | Phase 2 的 PoC；实在不行明确写进文档 |
| 包体与构建时长 | 用户体验、CI 成本 | 按需驱动、LTO 调优、缓存 |
| 许可证 | 静态链接 LGPL（GEOS）的分发义务 | GEOS 静态链接进 `.node`；义务落在**发布物**（附对应源码 + 重建/重链接材料，§6），源码许可证不变；新增依赖需过 license 门禁。见 `docs/GEOS.md` |

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
