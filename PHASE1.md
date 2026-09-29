# Phase 1 — 功能缺口与 API 稳定性
> 对标对象：**`gdal-async`**（node-gdal-async，GDAL 3.13，MIT，
> <https://mmomtchev.github.io/node-gdal-async/>）。
> 本文只做两件事：**（A）把差距列清楚**，**（B）定下 API 稳定性的规则和补齐顺序**。
> 上游 `ROADMAP.md` 的 Phase 0（发布）不在此范围内。

---

## 进度

| 工作流 | 状态 | 交付 |
|---|---|---|
| 文档 | ✅ 已落地 | `docs/API-STABILITY.md` —— 命名/索引/取值/资源/增长/弃用/能力探测/兼容立场 |
| WS-6 波段元数据写回 | ✅ 已完成 | `setScale` / `setOffset` / `setUnitType` / `setDescription` / `setCategoryNames` |
| WS-6 直方图写回 | ✅ 已完成 | `defaultHistogram(force?)` / `setDefaultHistogram()`，与 `statistics()` / `setStatistics()` 对齐 |
| B2 特性探测 | ✅ 已完成 | `gdal.apiVersion`、`gdal.features()` |
| WS-5 常量枚举 | ✅ 已完成 | `gdal.const` —— `DataType`/`FieldType`/`Justification`/`GeometryType`/`ColorInterpretation`/`Resampling`/`OverviewResampling`/`SqlDialect`，纯 JS（`index.js`）+ 逐值对照运行时的测试 |
| WS-1 几何对象模型 | ⏳ 待 C1 | 杠杆最大，需先定 GEOS 决策 |
| WS-2 Driver/Dataset 对象模型 | ✅ 已完成 | `Driver` 对象（+`createCopy`）、`dataset.driver` 对象化、`open({drivers})`、`Dataset.description`/`rasterSize`/`getFileList`、`setProjection` 收 `SpatialRef`。集合类**不做**，见下 |
| WS-3 Feature/Field 对象模型 | ✅ 已完成 | `layer.field(name)`/`addField`/`deleteField`/`reorderFields`、`FieldInfo` 全量定义、`layer.features()`（异步）、`layer.setSpatialFilter(geom)`、`layer.defn`（`FeatureDefn`）、`layer.getFeature(fid)` → `Feature`（`fields` 直写穿、`geometry`、`defn`、`toObject`） |
| WS-4 异步人体工学 | ⏳ 与 Phase 2 锁模型同批 | |
| WS-7 兼容层 | ⏳ 依赖 WS-1..3 | |

### 一个修正：`gdal.const` 应该是字符串词汇，不是 GDAL 数字码

原计划（B2.5）说导出 `GDT_*` / `OFT_*` / `GCI_*` 等数字常量，让它们与现有字符串
“两者都能用”。实测下来这是错的方向：本绑定的公开取值**本来就是字符串**
（`band.colorInterpretation === 'GrayIndex'`、`fieldType === 'String'`、
`resampling: 'average'`），返回数字常量会给出一个本 API 既不返回也不接受的词汇表，
反而制造“能用”的错觉。

所以 `gdal.const` 改为冻结**现有字符串词汇**：`gdal.const.ColorInterpretation.RedBand === 'RedBand'`、
`gdal.const.FieldType.Integer64 === 'Integer64'`、`gdal.const.Resampling.Average === 'average'`。
这才是真正的 API 稳定性收益 —— 把事实上已经在用的契约写成明文。
GDAL 的数字码属于兼容层（WS-7），那里 `gdal-async` 的形状才是目标。

### 两个已定案的分歧：集合类，与 `Feature.geometry`

**1. 集合类不做。** 本 API 的 `drivers()` / `bands()` / `layers()` 返回**就是数组** ——
数组本身已经具备 `for…of`、`forEach`、`map` 与 `Symbol.iterator`；而 `gdal-async` 集合对象多出来的
`.get()` / `.count()`，在这里等价于现成的单数访问器：`band(i)` / `layer(i)` / `driver(name)` 与
`bandCount` / `layerCount` / `drivers().length`。再套一层集合对象，要么改掉数组返回（违反「只增不改」），
要么在 JS 侧包装数组 —— 而**生成的 `binding.d.ts` 拥有这些方法的返回类型**，包装后的类型没有地方声明。
因此集合那层形状留给兼容层（WS-7），那里类型本来就是手写的。`Layer.fields` 同理：它是快照数组，
增删改由 `addField` / `deleteField` / `reorderFields` 承担，`get(name)` 由 `field(name)` 承担。

**2. `Feature.geometry` 仍是 GeoJSON。** 几何对象模型（WS-1）尚未落地，所以 `feature.geometry`
与 `createFeature` / `setGeometry` 收发的是同一套 GeoJSON，而不是 `Geometry` 实例。WS-1 落地时
在这里加一个 `Geometry` 重载即可，现有形状不变 —— 与 `setProjection` 收 `SpatialRef` 是同一种做法。

（一个实现时才发现、值得记下的细节：GDAL 有**两套**重采样词汇。像素读取与 `warp` /
`reprojectImage` 用 `Resampling`，最近邻拼作 `nearestneighbour`；`buildOverviews` 用
`OverviewResampling`，最近邻是 `nearest`，另多出 `rms` / `average_magphase` / `none`
（`none` 表示删除金字塔）。两者分别导出，不合并。色彩解释同理是 GDAL 的全名——`RedBand`
而不是 `Red`。）

---

## 0. 结论摘要

三个判断：

1. **最大的缺口不是"少几个函数"，而是缺少对象模型。** 我们的 API 是
   *扁平、记录式、直接映射 GDAL C 函数*：要素是 `{fid, properties, geometry}` 普通对象，
   几何是 GeoJSON `any`，驱动只有名字。`gdal-async` 是 *对象式、映射 GDAL C++ 对象模型*：
   `Geometry` 类族、`Feature`/`FeatureDefn`/`FieldDefn`、`Driver`、`ColorTable`、`MDArray`。
   这两者不是同一种 API，补几个函数补不平。

2. **几何对象模型受 GEOS 决策硬约束。** `gdal-async` 内置 GEOS，所以有
   `intersects / buffer / union / intersection / difference / distance / simplify /
   convexHull / isValid`；我们刻意不链 GEOS（LGPL 传染）。**这条不解决，几何 API 只能补一半。**
   好消息：`diagnostics().geosAvailable` 已经在运行时报告这件事，设计位是留好的。

3. **不要试图把自有 API 改成 `gdal-async` 的样子。** 索引基数（我们 0-based，它 1-based）、
   命名（我们 `xxxSync`/Promise，它 `xxx`/`xxxAsync`）、赋值方式（我们 `setX()`，它 `x =`）
   都是不兼容的。**推荐双轨**：自有 API 补全对象模型并冻结；另加一个
   **纯 JS 的 `gdal-rs-napi/compat` 兼容层**，让迁移只改一行 import。

---

## A. 差距矩阵

图例：✅ 有；🟡 部分；❌ 无。

### A1. 全局模块

| gdal-async | 我们 | 备注 |
|---|---|---|
| `version` | ✅ `version()` | 返回 `{gdal, proj}` |
| `bundled` | 🟡 `info().build` | 无单一布尔 |
| `drivers`（集合，`drivers.get('GTiff')`） | 🟡 `drivers()` 只返回 `{name, longName}` | **缺 Driver 对象** |
| `lastError`（`{number, message, type}`） | ✅ `lastError()`（`{class, number, message}`） | 语义对齐 |
| `verbose()` / `quiet()` | ❌ | GDAL 日志级别 |
| `eventLoopWarning` | ❌（我们用全局锁，无此概念） | 见 A8 |
| `setPROJSearchPaths` | 🟡 `configureDataPaths()` | 行为等价 |
| 常量枚举（`GDT_*`, `GCI_*`, `OFT_*`, `OLC*`, `DCAP_*`, `wkb*`, `GRA_*`, `CPLE_*`, `DIM_*`…） | 🟡 只有 `DataType`（字符串枚举） | **缺其余全套** |
| `info` / `infoAsync` | 🟡 `info()` 仅同步 | |

### A2. Dataset

| gdal-async | 我们 | 备注 |
|---|---|---|
| `open(path, mode, drivers, x, y, bands, type, options)` | ✅ `open(source, options)` | 驱动白名单、创建合一的签名不同 |
| `openAsync` | ✅ `open()` 返回 Promise | |
| `bands`（`DatasetBands` 集合） | 🟡 `bands(): RasterBand[]` | 无 `.get()/.count()/.forEach()/.map()`/迭代器 |
| `layers`（`DatasetLayers` 集合） | 🟡 `layers()`, `layer(i)`, `layerByName()` | 同上 |
| `rasterSize` / `rasterSizeAsync` | 🟡 `width`/`height` | 无对象、无 async getter |
| `geoTransform`（可读写） | ✅ getter + `setGeoTransform()` | 赋值风格不同 |
| `srs`（getter/setter + `srsAsync`） | 🟡 `spatialRef` getter + `setProjection(wkt)` | **setter 只收 WKT**，不收 `SpatialRef` |
| `driver` | 🟡 `driver: string` | **是名字，不是 Driver 对象** |
| `getFileList()` | ❌ | 廉价且实用 |
| `flush` / `flushAsync` | ✅ `flushSync()`/`flush()` | |
| `close()` | ✅ | |
| `buildOverviews` | ✅ | |
| `layer` 创建（`layers.create()`） | ✅ `createLayer(options)` | |
| `layers.copy()` | ❌ | |
| `root`（`Group`，多维入口） | ❌ | 见 A7 |
| `threadSafe` | ✅ | |
| `description` / `metadata` | 🟡 `metadata(domain)` | 无 `description` |
| `getEnvelope()` | 🟡 Layer 有 `extent`；Dataset 无 | |

### A3. RasterBand

| gdal-async | 我们 | 备注 |
|---|---|---|
| `pixels`（`RasterBandPixels`）| ❌ | 我们有 `readPixels`/`readValues`/`getPixel` 直接挂在 band 上 |
| `overviews`（集合 + 迭代器） | 🟡 `overviews` 数组 | 无 `.get()/.count()` |
| `colorTable` / `colorTableAsync` | ❌ | **完全缺失** |
| `mask` / `maskAsync` | ❌ | mask band |
| `noDataValue`（可赋值） | 🟡 `noDataValue` + `setNoDataValue()` | |
| `scale` / `offset` / `unitType` / `description` | 🟡 只读 | **缺 setter** |
| `categoryNames` | 🟡 只读 | **缺 setter** |
| `colorInterpretation` | ✅ 字符串 | |
| `dataType` / `blockSize` / `size` | ✅ | |
| `computeStatistics` | ✅ `statistics()` | |
| `getStatistics` / `setStatistics` | 🟡 `statistics({force:false})` + `setStatistics()` | |
| `getHistogram` / `setHistogram` | 🟡 只有读 | **缺写** |
| `checksumImage` | ✅ `checksum()` | |
| `fill` / `fillNoData` / `sieveFilter` | ✅ | |
| `rasterize` / `polygonize` / `contourGenerate` | ✅（在 Dataset/Band 上） | |
| `asMDArray()` | ❌ | 见 A7 |
| `unitType` 等 async getter | ❌ | |

### A4. 矢量（Feature / Layer / Field）

| gdal-async | 我们 | 备注 |
|---|---|---|
| `Feature` 类（`fields`、`geometry`、`fid`、`defn`） | ❌ | 我们是普通对象 `FeatureRecord` |
| `FeatureFields`（`.get/.set/.toObject/.toArray/.forEach`） | ❌ | 直接给 `properties` 普通对象 |
| `FeatureDefn` / `FieldDefn` | ❌ | **无 schema 对象**；`FieldInfo` 只是快照 |
| `Layer.fields`（可 `add/remove/reorder/alter`） | ❌ | 只能在 `createLayer` 时声明；**无法改已存在图层的 schema** |
| `Layer.features`（集合：`get/first/last/next/previous/count/forEach/Symbol.iterator/Symbol.asyncIterator`） | 🟡 `featuresSync()` + `openCursor()` | 无迭代器协议、无 `first/last/next/previous` |
| `Layer.getFeature(fid)` | ✅ `feature(fid)` | |
| `Layer.setSpatialFilter(geom)`（收几何对象） | ❌ | 只有 `setSpatialFilterRect()` |
| `Layer.srs`（getter/setter） | 🟡 只读 `spatialRef`/`spatialRefWkt` | |
| `Layer.geomType` / `fidColumn` / `geomColumn` / `testCapability` | ✅ | |
| `Layer.extent`（可赋值） | 🟡 只读 | |
| 字段值类型：list 字段、Date/Time/Binary | 🟡 读有，写受限 | 见 ROADMAP 已知缺口 |

### A5. Geometry（最大的洞）

`gdal-async` 有完整类族：`Geometry` 基类 +
`Point` / `LineString` / `LinearRing` / `Polygon` / `MultiPoint` / `MultiLineString` /
`MultiPolygon` / `GeometryCollection` / `CircularString` / `CompoundCurve` / `SimpleCurve` /
`Envelope` / `Envelope3D`，以及集合属性
（`Point`、`LineStringPoints`、`PolygonRings`、`GeometryCollectionChildren`…）。

方法（已验证存在于上游文档）：

- **不需要 GEOS**：`getArea()`、`getLength()`、`getEnvelope()`、`getGeometryType()`、
  `toWKT()`、`toWKB()`、`toJSON()`/`toObject()`、`fromWKT/fromWKB/fromObject`、
  点访问（`getX/getY/getZ`）、`flatten`/`segmentize`/`swapXY`/`transform`。
- **需要 GEOS**：`intersects`、`contains`、`within`、`crosses`、`touches`、`overlaps`、
  `disjoint`、`equals`、`distance`、`buffer`、`centroid`、`convexHull`、`simplify`、
  `union`、`intersection`、`difference`、`symDifference`、`isValid`、`isSimple`、`isEmpty`。

**我们目前：** 只有 `geometryTypeOf / geometryToWkt / geometryToWkb / geometryFromWkt /
geometryFromWkb` + `transformGeometry`（走 GeoJSON `Value`）。**几何是 `any`，没有对象。**

### A6. 算法与工具

| gdal-async | 我们 |
|---|---|
| `translate` / `warp` / `vectorTranslate`（+Async） | ✅ |
| `dem` / `demAsync` | ✅ `demProcess` |
| `buildVRT` / `buildVRTAsync` | ✅ `buildVrt` |
| `wrapVRT` | ❌ |
| `reprojectImage` | ✅ |
| `rasterize` / `polygonize` / `contourGenerate` | ✅ |
| `sieveFilter` / `fillNodata` / `checksumImage` | ✅ |
| `suggestedWarpOutput` | ✅ |
| `calcAsync`（`gdal_calc.py` 替代） | ❌ |
| `addPixelFunc` / `createPixelFunc` / `toPixelFunc`（VRT 像素函数） | ❌ |
| `toDataType` / `fromDataType` | 🟡 `DataType` 枚举 + `bytesPerSample` |
| `decToDMS` | ❌ |

### A7. 多维模型与流（整块缺失）

- `MDArray` / `Group` / `Attribute` / `Dimension` 及各自的集合 —— ❌
- `RasterReadStream` / `RasterWriteStream` / `RasterMuxStream` / `RasterTransform` —— ❌

### A8. 异步人体工学（影响服务端可用性的核心差距）

| 能力 | gdal-async | 我们 |
|---|---|---|
| 方法级异步 | ✅ `xxxAsync` + callback 双形态 | 🟡 `xxxSync` / `xxx(): Promise` |
| **异步 getter** | ✅ `rasterSizeAsync`、`srsAsync`、`colorTableAsync`… | ❌ 所有 getter 都是同步的 |
| **异步迭代器** | ✅ `for await (const f of layer.features)` | ❌ 只有 `openCursor().read()` 手写循环 |
| 同步迭代器 | ✅ `for (const f of layer.features)` | ❌ |
| **每数据集 I/O 队列** | 🟡 有 per-dataset mutex（`libuv` 线程池调度） | ❌ **进程级全局 `RwLock`** |
| 线程安全数据集 | ✅ 打开时 `'rt'` 标志 | ✅ `openThreadSafe()` |
| 事件循环阻塞告警 | ✅ `eventLoopWarning` | ❌ |

**为什么异步 getter 重要：** `gdal-async` 的文档明确说明——不能在同一个 Dataset 上启动 I/O
之后再去读同步 getter，否则会阻塞事件循环。**我们的问题更严重**：全局锁意味着
`Promise.all` 下十个 `readPixels()` 仍然是串行的。所以"补异步 getter"对我们不是锦上添花，
而是与锁模型配套的必需品；否则"异步"这个卖点是空的。

---

## B. API 稳定性

### B1. 现状风险

| 风险 | 说明 |
|---|---|
| 风格未冻结 | 现在是 0.x，任何补全都可能顺手改命名，越晚冻结越贵 |
| 生成的 `binding.d.ts` | 61KB 自动生成，用户直接依赖它，但没有"这是契约"的声明 |
| 字符串即枚举 | `fieldType: 'String'`、`colorInterpretation: 'RedBand'`、`dataType: 'Float32'`——拼错只在运行时炸（`gdal.const` 已缓解：拼错变成一个可引用的名字） |
| 错误码只覆盖同步路径 | 异步方法无法给 `err.code`（README 已承认） |
| 索引基数 | 0-based 是我们的约定，但与 `gdal-async` 相反，必须写死在文档里 |
| 无弃用机制 | 没有 `@deprecated` 流程，也没有 `apiVersion` 供用户特性探测 |

### B2. 冻结规则（建议写入 `docs/API-STABILITY.md`）

1. **命名**：动词开头；阻塞版一律 `xxxSync()`，异步版一律 `xxx(): Promise<T>`。
   **不引入 `Async` 后缀**（避免与兼容层混淆）。
2. **索引**：数组式资源（band / layer / field）在自有 API 里**永远 0-based**，
   并在每个 getter 的 JSDoc 里重复一次。`RasterBand.id` 保留 GDAL 的 1-based 原样，
   作为唯一的例外并明确标注。
3. **资源关闭**：`close()` 幂等；关闭后一切操作抛 `GDAL_BAD_ARGUMENT`（已实现，保持不变）。
4. **返回值**：失败一律 throw；"没有"用 `null`，不用 `undefined`（现已基本一致）。
5. **新增枚举**：**只增不改**。把 `GDT_*`、`OFT_*`、`GCI_*`、`OLC*`、`DCAP_*`、`GRA_*`
   作为 `gdal.const` 下的常量对象导出；现有字符串形式**保留**，两者都能用。
   这样是纯增量，不破坏任何已有代码。
6. **重载而非改名**：`setProjection(wkt)` 增加接受 `SpatialRef` 的重载，而不是改成 `setSrs()`。
7. **弃用**：`@deprecated` + `CHANGELOG` 标注，保留 ≥2 个 minor，major 才删。
8. **特性探测**：加 `gdal.apiVersion`（自有 API 版本，区别于 `version()` 的 GDAL 版本）
   与 `gdal.features()`（`{ geos: false, mdArray: false, streams: false, compat: true }`）。
9. **类型契约**：`binding.d.ts` 顶部加"generated, but the shape is the contract"说明；
   `types.test.mjs` 扩展为"声明与运行时一致"检查。

### B3. 兼容层：`gdal-rs-napi/compat`（推荐）

纯 JS、零原生改动，把自有 API 适配成 `gdal-async` 的形状，让迁移是**改一行 import**：

```js
// before
const gdal = require('gdal-async')
// after
const gdal = require('gdal-rs-napi/compat')
```

覆盖范围与代价：

| 可适配 | 方式 | 代价 |
|---|---|---|
| 1-based 索引 | `band(i)` 内部 `i-1` | 低 |
| `xxxAsync` 后缀 + callback 形态 | 包一层 Promise / `node:util.callbackify` | 低 |
| `drivers.get(name)`、`DatasetBands.get()`、`LayerFields.get()` | JS 集合类 | 低 |
| `Feature.fields.toObject()`、`Feature.geometry` 对象 | JS 包装 | 低 |
| `Geometry` 类族 + `toJSON()/toWKT()` | 包 `geometryFromWkt` 等 | 中 |
| 几何谓词 | **只有启用 GEOS 的构建才能真适配** | 见 C1 |
| 异步 getter | 包成 Promise，但不改变底层串行事实 | 低（语义有差） |
| `pixels.readAsync()` | 包 `readPixels()` | 低 |
| Streams / MDArray | 不做 | — |
| 同步迭代器 `Symbol.iterator` | 在 compat 里实现（也值得进自有 API） | 低 |

**这不是"两套 API 维护负担"**：compat 层只是适配器，不复制逻辑；自有 API 演进时
compat 层用测试锁住形状即可。它的价值是——**让 `gdal-async` 用户零成本试我们的包**，
而这是"无宿主依赖"这个卖点唯一能被验证的方式。

---

## C. 分阶段补全顺序

排序依据：**(用户影响 × 可行性) / 依赖**。

### C1. 先决决策：GEOS（阻塞 A5 的一半）

三选一，Phase 1 内必须定：

| 方案 | 内容 | 评价 |
|---|---|---|
| **A. 不做** | 几何 API 只提供非 GEOS 子集，谓词方法不存在；`diagnostics().geosAvailable === false` 时文档指向"用 PostGIS/GEOS 外部处理" | 成本最低，但"几何"能力远低于 `gdal-async` |
| **B. 单独 GEOS 变体包** | 默认包不带 GEOS；另发 `gdal-rs-napi-geos`（动态链接系统 GEOS，或静态 + 可重链接对象以合规 LGPL） | **推荐**。保住默认包的许可证纯净，同时给出功能对等路径 |
| **C. Rust `geo` crate 自实现** | 不依赖 GEOS | 语义与 GEOS 不一致，工作量大，不推荐 |

**建议：Phase 1 选 A 落地对象模型（方法按 `geosAvailable` 条件注册），同时把 B 排进 Phase 2。**
这样对象模型不被 GEOS 阻塞，功能对等有明确路径。

### C2. 工作流

**WS-1 · 几何对象模型**（最大收益，无原生依赖）
- `Geometry` 类族：`Point` / `LineString` / `LinearRing` / `Polygon` / `Multi*` /
  `GeometryCollection`；`toWkt/toWkb/toJson/fromJson`；点与环的访问器。
- 非 GEOS 方法：`getArea`、`getLength`、`getEnvelope`、`transform`、`flatten`、`segmentize`。
- GEOS 门控方法：按 `geosAvailable` 决定是否注册（指向 C1-B）。
- 从 `FeatureRecord.geometry`（GeoJSON）与 `layer.createFeature` 双向打通：
  既能收 `Geometry` 也能收 GeoJSON 普通对象。
- 验收：`layer.features` 里的几何是 `Geometry` 实例；`polygonize`/`rasterize` 也能收它。

**WS-2 · Driver 与 Dataset 对象模型**
- `Driver`：`name`、`longName`、`description`、`metadata(DMD_*)`、`open()`、`create()`、
  `createCopy()`、`delete()`、`testCapability()`。
- `gdal.drivers` 变成集合（`get(name)`、`count()`、`Symbol.iterator`），
  **保留 `drivers()` 数组形式**（纯增量）。
- `Dataset`：`getFileList()`、`description`、`rasterSize` 对象、`srs` setter（收 `SpatialRef`）、
  `driver` 返回 Driver 对象（名字仍可用 `driver.name`）。
- `DatasetBands` / `DatasetLayers` 集合类 + `Symbol.iterator` / `Symbol.asyncIterator`。

**WS-3 · Feature / Field 对象模型**
- `Feature`：`fid`、`fields`（`get/set/toObject/toArray/forEach`）、`geometry`（`Geometry`）、
  `defn`。**保留** `FeatureRecord` 普通对象形式（`featuresSync()` 不动，新增 `features()`）。
- `FieldDefn` / `FeatureDefn`：`name/type/width/precision/justification/nullable/default`。
- `Layer.fields` 从只读数组升级为集合，支持 `add`/`remove`/`reorder`/`alter`。
- `Layer.setSpatialFilter(geometry)` 重载（收 `Geometry` 或 GeoJSON）。
- 验收：不用 `createLayer` 声明 schema，也能给已存在图层加字段。

**WS-4 · 异步人体工学**
- 集合的 `Symbol.asyncIterator`（`Layer.features`、`cursor`、`Dataset.bands/layers`）。
- 异步 getter：`rasterSize()`、`srs()`、`colorTable()` —— 与锁模型配套，避免"启动 I/O 后读同步 getter"。
- `eventLoopWarning` 等价物：同步操作阻塞事件循环超阈值时告警（可选，但能与 `gdal-async` 行为对齐）。
- 与 Phase 2 的锁优化的接口约定：getter 一律先尝试非阻塞路径。

**WS-5 · 常量与枚举**
- `gdal.const`：`GDT_*`、`OFT_*`、`GCI_*`、`OLC*`、`DCAP_*`、`GRA_*`、`CPLE_*`、`wkb*`。
- `gdal.features()` 特性探测。
- 纯增量，最低风险，可并行做。

**WS-6 · 缺口函数（低垂果实）**
- 波段：`colorTable`（读+写）、`mask`、`scale/offset/unitType/description` setter、
  `setDefaultHistogram`。
- Dataset：`getFileList()`、`description`。
- 工具：`decToDMS`、`wrapVRT`、`toDataType`/`fromDataType`。
- 矢量：list 字段写入、Date/Time/Binary 完整读写。

**WS-7 · 兼容层**（依赖 WS-1..WS-3 的形状稳定）
- 发布 `gdal-rs-napi/compat`；用 `gdal-async` 的真实示例当验收测试。

**WS-8 · 明确不做（记为设计取舍，写进 README）**
- MDArray / 多维模型（A7）
- Node Streams（A7）
- `calcAsync` / 像素函数

### C3. 顺序与依赖

```
C1 (GEOS 决策) ──┐
                 ├─> WS-1 几何对象模型 ──┐
WS-5 常量 ───────┘                       ├─> WS-7 兼容层
WS-2 Driver/Dataset 对象模型 ────────────┤
WS-3 Feature/Field 对象模型 ─────────────┤
WS-4 异步人体工学 ───────────────────────┘
WS-6 缺口函数 ──（可全程并行，按需插入）
```

- **WS-5 与 WS-6 无依赖，立刻可开。**
- **WS-1 是杠杆最大的一件事**：它同时解锁 WS-3（Feature.geometry）和 WS-7。
- **WS-4 的异步 getter 必须与 Phase 2 的锁模型一起定接口**，否则会做出"看起来异步但实际串行"的 API。

### C4. 里程碑验收

| 里程碑 | 验收标准 |
|---|---|
| M1 | `gdal.const` 导出全套枚举；`gdal.features()` 可用；波段 setter 与 histogram 写回完成 |
| M2 | `Geometry` 类族可构造、可往返、`layer.features` 返回 `Geometry`；非 GEOS 方法齐 |
| M3 | `Driver`/`Dataset`/`Feature`/`FieldDefn` 对象模型齐；集合支持 `for…of` 与 `for await…of` |
| M4 | `require('gdal-rs-napi/compat')` 能跑通 `gdal-async` README 与 examples 里的例子 |
| M5 | `docs/API-STABILITY.md` 成文；`apiVersion` 与弃用流程可用；`types.test.mjs` 覆盖声明一致性 |

---

## D. 风险

| 风险 | 影响 | 应对 |
|---|---|---|
| GEOS 缺席 | 几何能力减半，是`gdal-async`最强的差异化 | C1-B 变体包；运行时用 `geosAvailable` 明确报告 |
| 对象模型导致 API 面积翻倍 | 文档/类型/测试成本 | 对象模型与现有函数式 API **并存**，不是替换；共享同一原生实现 |
| 异步 getter 的"假异步" | 用户误以为并行 | WS-4 与 Phase 2 锁优化同批交付；文档直说 |
| 兼容层语义漂移 | 迁移后行为不同 | 用 `gdal-async` 官方 examples 作验收；CI 跑兼容测试 |
| 枚举与字符串双轨 | 长期双份维护 | 明确字符串为"便捷形式"、枚举为"规范形式"，1.0 时评估是否降级字符串 |
