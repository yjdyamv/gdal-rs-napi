# Phase 1 — 功能缺口与 API 稳定性
> 对标对象：**`gdal-async`**（node-gdal-async，GDAL 3.13，MIT，
> <https://mmomtchev.github.io/node-gdal-async/>）。
> 本文只做两件事：**（A）把差距列清楚**，**（B）定下 API 稳定性的规则和补齐顺序**。
> 上游 `ROADMAP.md` 的 Phase 0（发布）不在此范围内。
>
> **本文是当时（v0.2 前）的分析快照**；与 `gdal-async` 3.13 的最新逐项对照、能力边界
> （哪些明确不做及理由）与分级路线图，见 [`docs/PARITY.md`](./docs/PARITY.md)。

---

## 进度

| 工作流 | 状态 | 交付 |
|---|---|---|
| 文档 | ✅ 已落地 | `docs/API-STABILITY.md` —— 命名/索引/取值/资源/增长/弃用/能力探测/兼容立场 |
| WS-6 波段元数据写回 | ✅ 已完成 | `setScale` / `setOffset` / `setUnitType` / `setDescription` / `setCategoryNames` |
| WS-6 直方图写回 | ✅ 已完成 | `defaultHistogram(force?)` / `setDefaultHistogram()`，与 `statistics()` / `setStatistics()` 对齐 |
| WS-6 调色板 | ✅ 已完成 | `colorTable` / `paletteInterpretation` / `setColorTable(entries, interpretation?)` —— 分量是无符号 16 位（crate 读成 `i16`，边界处转回），解释随表；MEM / VRT 无损，GTiff 只有 8 位 × 256 项 |
| WS-6 掩膜波段 | ✅ 已完成 | `mask` / `maskFlags` / `createMask(perDataset?)` —— 掩膜是一条完整 `RasterBand`（读走共享锁）；没掩膜时给隐式"全有效"波段（只读、全 255）；`maskFlags` 区分存储型与派生型（`alpha` / `noData`） |
| WS-6 其余小工具 | ✅ 已完成 | `gdal.decToDMS(angle, axis, precision?)`（`CPLDecToDMS`）、`gdal.verbose()` / `gdal.quiet()`（把 `CPL_DEBUG` 设成 `ON` / `OFF`）、`toDataType` / `fromDataType`（收/发本绑定的字符串词汇，也接受 GDAL 拼写）、`gdal.bundled`。`wrapVRT` 不另开门：`translate(dest, ['-of','VRT'])` 就是它 |
| WS-6 GCP / Driver / fs / flush | ✅ 已完成 | `getGCPs`/`setGCPs`/`gcpProjection`/`gcpCount`、`Dataset.getEnvelope()`、`Driver.rename`/`copyFiles`、`fs.clearCurlCache()`、`RasterBand.flush`/`Layer.flush` |
| WS-1 几何补全 | ✅ 已完成 | `makeValid`/`boundary`/`pointOnSurface`/`unaryUnion`/`concaveHull`/`normalize`/`setPrecision`/`isRing`/`toGML`/`toKML` —— 至此 A5 的整套方法与谓词齐全（类族不做的理由见 A5） |
| WS-5 CRS 补全 | ✅ 已完成 | `fromESRI`/`morphToESRI`/`morphFromESRI`/`toXML`/`validate`/`cloneGeogCS`/`setWellKnownGeogCS`/`epsgTreatsAsLatLong`/`isGeocentric`/`isLocal`/`isSameGeogCS`/`isSameVertCS`/`getAttrValue`/`autoIdentifyEPSG` |
| WS-3 波段代数与类型 | ✅ 已完成 | `add`/`sub`/`mul`/`div`/`pow`、`abs`/`sqrt`/`log`/`log10`、比较、逻辑、`ifThenElse`、`asType` —— **eager**（结果是独立的内存波段），不取 VRT 像素函数路线，理由见 A3/A6 |
| WS-7 流 | ✅ 已完成 | `band.createReadStream()` / `createWriteStream()`（外壳实现，见 A7） |
| WS-3 图层拷贝 | ✅ 已完成 | `dataset.copyLayer(source, name, options?)` —— `GDALDatasetCopyLayer`，经 `with_two`（锁不可重入，两个句柄必须同源）；**源必须是不同数据集**，自拷贝被明确拒绝而不是死锁 |
| WS-4 流式读取异步孪生 | ✅ 已完成 | `band.readChunks(options, onChunk)` —— 与 `readChunksSync` 同一条 `read_sync` 逐条走法，搬到线程池；每条经 threadsafe function 交给 JS，返回值即背压；回调不得重入（同 `onProgress`） |
| B2 特性探测 | ✅ 已完成 | `gdal.apiVersion`、`gdal.features()` |
| WS-5 常量枚举 | ✅ 已完成 | `gdal.const` —— `DataType`/`FieldType`/`Justification`/`GeometryType`/`ColorInterpretation`/`Resampling`/`OverviewResampling`/`SqlDialect`，纯 JS（`index.js`）+ 逐值对照运行时的测试 |
| C1 GEOS 决策 | ✅ 已定 | 自行构建 + **静态链接**（`geos_static`，进入 `bundled` 默认开启），见 [`docs/GEOS.md`](./docs/GEOS.md) |
| WS-1 几何对象模型 | ✅ 已完成 | `gdal.Geometry` 类已落地（`fromWkt`/`fromWkb`/`fromJson`、`toWkt`/`toWkb`/`toJson`、`type`/`isEmpty`/`pointCount`/`area`/`length`/`envelope`、`flattenTo2D`/`segmentize`/`swapXY`/`transform`）；写入端已能收 `Geometry` 或 GeoJSON（`createFeature`/`updateFeature`/`setSpatialFilter`/`Feature.setGeometry`/`rasterize`/`transformGeometry`）；GEOS 谓词与集合运算已写好并带 `has_geos()` 守卫（`intersects`/`contains`/…/`buffer`/`union`…，共 19 个）；按形状的访问器（`x`/`y`/`z`、`points`、`rings`/`exteriorRing`/`interiorRings`、`children`、`coordinates`）；GEOS 已**默认静态链入**（Windows/MSVC 上实测 `features().geos === true`，谓词与集合运算跑通）；后续又补了 `makeValid`/`boundary`/`pointOnSurface`/`unaryUnion`/`concaveHull`/`normalize`/`setPrecision`/`isRing`/`toGML`/`toKML`。**类族不做**（见下）。**待**只剩其余平台验证（属发布范围） |
| WS-2 Driver/Dataset 对象模型 | ✅ 已完成 | `Driver` 对象（+`createCopy`）、`dataset.driver` 对象化、`open({drivers})`、`Dataset.description`/`rasterSize`/`getFileList`、`setProjection` 收 `SpatialRef`。集合类**不做**，见下 |
| WS-3 Feature/Field 对象模型 | ✅ 已完成 | `layer.field(name)`/`addField`/`deleteField`/`reorderFields`、`FieldInfo` 全量定义、`layer.features()`（异步）、`layer.setSpatialFilter(geom)`、`layer.defn`（`FeatureDefn`）、`layer.getFeature(fid)` → `Feature`（`fields` 直写穿、`geometry`、`defn`、`toObject`） |
| WS-4 异步人体工学 | ✅ 已完成 | `FeatureCursor` 已可用 `for await`（外壳加的，读的仍是同一个 `read()`）；异步错误已带 `err.code`（外壳从消息前缀提取）；`CoordinateTransform.transformPoints` 已跑在线程池上（点数组，百万点不必调用方分块，同步版更名 `transformPointsSync`）；`band.readChunks` 是 `readChunksSync` 的异步孪生；只读 getter 的异步孪生也补齐了（19 个 `xxxAsync`）。**不做**（非目标，理由见下）：`Dataset.bands/layers` 的异步迭代、`eventLoopWarning` |
| WS-7 兼容层 | ✅ 已完成 | `gdal-rs-napi/compat` 已落地：1-based 索引、`xxx()`/`xxxAsync()`（含 node 回调形态）、setter 赋值（`noDataValue`/`geoTransform`/`srs`）、`Driver` 与各集合、`Feature`（`fields.toObject`/`toArray`、可赋值 `geometry`）、`SpatialReference`、几何类族（含 `instanceof`、`toWKT`/`toJSON`/`get*`）。**不做**：本绑定自己定形状的波段附加物——`colorTable`/`mask`/流（形状在主入口上，不在兼容层包装里）。多维模型、`calcAsync` 与 VRT 像素函数也已在主入口落地；多维模型另在 compat 里做了 `Group`/`MDArray`/`Attribute`/`Dimension` 与六个集合的重包装，`calcAsync` 与像素函数则不在。 |

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

### 三个已定案的分歧：集合类、几何类族，与 `Feature.geometry`

**1. 集合类不做。** 本 API 的 `drivers()` / `bands()` / `layers()` 返回**就是数组** ——
数组本身已经具备 `for…of`、`forEach`、`map` 与 `Symbol.iterator`；而 `gdal-async` 集合对象多出来的
`.get()` / `.count()`，在这里等价于现成的单数访问器：`band(i)` / `layer(i)` / `driver(name)` 与
`bandCount` / `layerCount` / `drivers().length`。再套一层集合对象，要么改掉数组返回（违反「只增不改」），
要么在 JS 侧包装数组 —— 而**生成的 `binding.d.ts` 拥有这些方法的返回类型**，包装后的类型没有地方声明。
因此集合那层形状留给兼容层（WS-7），那里类型本来就是手写的。`Layer.fields` 同理：它是快照数组，
增删改由 `addField` / `deleteField` / `reorderFields` 承担，`get(name)` 由 `field(name)` 承担。

**2. 几何类族不做，改为按形状的访问器。** `gdal-async` 有 `Point` / `Polygon` / `MultiPolygon`…
一整套子类。我们这里不建：napi-rs **无法表达继承**（没有 `extends`），所以子类要么在 JS 侧用
`Object.setPrototypeOf` 假装 —— 那样 `instanceof` 有了，但**访问器类型没地方声明**（生成的
`binding.d.ts` 拥有 `Geometry.fromWkt()` 等的返回类型）—— 要么每个子类在 Rust 里复制一遍基类的方法。
两者都不值得。取而代之：**单一 `Geometry` 类 + 按形状作答的访问器**（`x`/`y`/`z`、`points()`、
`rings()`/`exteriorRing`/`interiorRings`、`children()`），能力与类族相同、类型齐全、可测；
`type` 说清是哪一种。类族那层形状（以及它带来的 `instanceof`）属于兼容层 WS-7。

**3. `Feature.geometry` 仍发 GeoJSON。** 写入端两种形状都收（`createFeature` / `updateFeature` /
`setSpatialFilter` / `Feature.setGeometry` / `rasterize` / `transformGeometry`），但读出来的
`featuresSync()` / `feature(fid)` 记录里，`geometry` 依旧是那份 GeoJSON 普通对象 —— 那是
`FeatureRecord`「拷贝出来的普通数据」这一设计的一部分，要对象形式就 `Geometry.fromJson(record.geometry)`，
或直接用 `layer.getFeature(fid)`（它的 `geometry` 同样如此，`fields` 才走图层）。把 getter 直接换成
`Geometry` 实例会同时打破「普通数据」和「只增不改」两条，所以不做。

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

> **本矩阵已按当前状态刷新**。仍标 ❌ 的只剩两类，且逐条给了理由：**做不到**（GDAL 的 C API
> 没有那个函数）与**已定案的取舍/非目标**（原生集合对象形态）。
> 🟡 表示能力齐、只是形状或拼法与 `gdal-async` 不同（那层形状归 `compat`）。

图例：✅ 有；🟡 有但形状不同；❌ 做不到 / 已定案不做。

### A1. 全局模块

| gdal-async | 我们 | 备注 |
|---|---|---|
| `version` | ✅ `version()` | 返回 `{gdal, proj}` |
| `bundled` | ✅ `gdal.bundled` | 单一布尔 |
| `drivers`（集合，`drivers.get('GTiff')`） | ✅ `drivers()` / `driver(name)` **返回 `Driver` 对象**；`dataset.driver` 也是对象 | 集合对象形态归 compat |
| `lastError`（`{number, message, type}`） | ✅ `lastError()`（`{class, number, message}`） | 语义对齐 |
| `verbose()` / `quiet()` | ✅ | 写 `CPL_DEBUG` |
| `eventLoopWarning` | ❌ **已定案不做** | 本绑定是一把全局锁，没有"某数据集上还挂着未完成的异步操作"这回事可警告；见 A8 |
| `setPROJSearchPaths` | ✅ `configureDataPaths()` | 行为等价 |
| 常量枚举（`GDT_*`, `GCI_*`, `OFT_*`, `OLC*`, `DCAP_*`, `wkb*`, `GRA_*`, `CPLE_*`, `DIM_*`…） | ✅ `gdal.const`（八个**字符串**词汇）+ `toDataType`/`fromDataType` 取数字码 | 数字码词汇属兼容层 |
| `info` / `infoAsync` | ✅ `info()`；`infoAsync` ❌ **非目标** | 异步 getter，见 A8 |

### A2. Dataset

| gdal-async | 我们 | 备注 |
|---|---|---|
| `open(path, mode, drivers, x, y, bands, type, options)` | ✅ `open(source, options)` | 签名不同：驱动白名单、创建合一 |
| `openAsync` | ✅ `open()` 返回 Promise | |
| `bands`（`DatasetBands` 集合） | ✅ `bands(): RasterBand[]`、`band(i)`、`bandCount` | 集合**对象**形态归 compat；数组本身已有 `for…of`/`map`/`forEach`/`length` |
| `layers`（`DatasetLayers` 集合） | ✅ `layers()`、`layer(i)`、`layerByName()`、`layerCount` | 同上 |
| `rasterSize` / `rasterSizeAsync` | ✅ `rasterSize` 对象；`rasterSizeAsync` ❌ 非目标 | 异步 getter，见 A8 |
| `geoTransform`（可读写） | ✅ getter + `setGeoTransform()` | 赋值风格不同 |
| `srs`（getter/setter + `srsAsync`） | ✅ `spatialRef` getter + `setProjection`（收 WKT 或 `SpatialRef`） | |
| `driver` | ✅ **`Driver` 对象**（`dataset.driver.name` 仍是名字） | |
| `getFileList()` | ✅ | |
| `flush` / `flushAsync` | ✅ `flushSync()`/`flush()` | |
| `close()` / `buildOverviews` | ✅ | |
| `layer` 创建（`layers.create()`） | ✅ `createLayer(options)` | |
| `layers.copy()` | ✅ `copyLayer(source, name, options?)` | |
| `root`（`Group`，多维入口） | ✅ `root`（需 `open(..., { multidimensional: true })`，即 `GDAL_OF_MULTIDIM_RASTER`；没有该标志 GDAL 根本不建 root group） | 见 A7 |
| `threadSafe` | ✅ | |
| `description` / `metadata` | ✅ | |
| `getEnvelope()` | ✅ `getEnvelope()` | 栅格按 geotransform 四角，矢量按图层 extent 并集 |

### A3. RasterBand

| gdal-async | 我们 | 备注 |
|---|---|---|
| `pixels`（`RasterBandPixels`）| ✅ `readPixels`/`readAs`/`writePixels`/`getPixel`/`setPixel`/`readValues`/`writeValues`/`readBlock`/`writeBlock` 直接挂在 band 上；`createReadStream`/`createWriteStream` 也在 | `pixels` **对象**形态归 compat |
| `overviews`（集合 + 迭代器） | ✅ `overviews` 数组（`index`/`size`/`dataType`/`readSync`/`read`） | |
| `colorTable` / `colorTableAsync` | ✅ `colorTable`/`paletteInterpretation`/`setColorTable` | |
| `mask` / `maskAsync` | ✅ `mask`/`maskFlags`/`createMask` | |
| `noDataValue`（可赋值） | ✅ `noDataValue` + `setNoDataValue()` | |
| `scale` / `offset` / `unitType` / `description` | ✅ 读写 | setter 齐全 |
| `categoryNames` | ✅ 读写 | |
| 波段代数（`add`/`sub`/`mul`/`div`/`pow`/`abs`/`sqrt`/`log`/`log10`/比较/逻辑/`ifThenElse`） | ✅ 逐元素、**eager**（结果落进新内存波段） | 参考实现走惰性 VRT 像素函数，见 A6 |
| `asType(type)` | ✅ 转成另一种样本类型的波段（eager MEM） | |
| `colorInterpretation` | ✅ 字符串 | |
| `dataType` / `blockSize` / `size` | ✅ | |
| `computeStatistics` | ✅ `statistics()` | |
| `getStatistics` / `setStatistics` | ✅ | |
| `getHistogram` / `setHistogram` | ✅ `histogram` / `defaultHistogram` / `setDefaultHistogram` | |
| `checksumImage` | ✅ `checksum()` | |
| `fill` / `fillNoData` / `sieveFilter` | ✅ | |
| `rasterize` / `polygonize` / `contourGenerate` | ✅（在 Dataset/Band 上） | |
| `asMDArray()` | ✅（`GDALRasterBandAsMDArray`；掩膜波段没有自己的数据集，GDAL 会拒绝） | |
| `unitType` 等 async getter | ❌ 非目标 | 见 A8 |

### A4. 矢量（Feature / Layer / Field）

| gdal-async | 我们 | 备注 |
|---|---|---|
| `Feature` 类（`fields`、`geometry`、`fid`、`defn`） | ✅ `layer.getFeature(fid)` → `Feature`（`fields`/`geometry`/`fid`/`defn`/`toObject`）；`FeatureRecord` 普通对象仍在 | |
| `FeatureFields`（`.get/.set/.toObject/.toArray/.forEach`） | ✅ `Feature.fields`（`get/has/set/names/count/toObject/toArray`） | |
| `FeatureDefn` / `FieldDefn` | ✅ `layer.defn`（`FeatureDefn`）、`FieldInfo` 即 `FieldDefn` | |
| `Layer.fields`（可 `add/remove/reorder/alter`） | ✅ `layer.field(name)` / `addField` / `deleteField` / `reorderFields` | |
| `Layer.features`（集合：`get/first/last/next/previous/count/forEach/Symbol.iterator/Symbol.asyncIterator`） | ✅ 能力齐：`featuresSync()`（同步可迭代数组）、`features()`（Promise）、`openCursor()`（`Symbol.asyncIterator`）、`feature(fid)` | `first/last/next/previous` 与集合**对象**形态归 compat |
| `Layer.getFeature(fid)` | ✅ `feature(fid)` 与 `getFeature(fid)`（对象形式） | |
| `Layer.setSpatialFilter(geom)`（收几何对象） | ✅ 收 `Geometry` 或 GeoJSON；`getSpatialFilter()` 是读侧 | |
| `Layer.srs`（getter/setter） | ❌ setter **做不到** | GDAL 的 C API 只有 `OGR_L_GetSpatialRef`，没有 setter（C++ 的 `OGRLayer::SetSpatialRef` 是虚函数，C 表面够不到）；走图层定义的几何字段在定义 seal 后被拒（GPKG 报 `not allowed on a sealed object`）。CRS 在 `createLayer({ epsg })` / `{ wkt }` 时给定 |
| `Layer.geomType` / `fidColumn` / `geomColumn` / `testCapability` | ✅ | |
| `Layer.extent`（可赋值） | ❌ setter **做不到** | GDAL 的 C API 没有 `OGR_L_SetExtent`；`extent` 只读，`getEnvelope` 同理 |
| 字段值类型：list 字段、Date/Time/Binary | ✅ 读有；写看驱动 | 已实测四种驱动（GeoJSON/SQLite 真存列表、GPKG 降级为标量、FlatGeobuf 拒绝写），推断坚持逗号连接文本；有测试钉住 |

### A5. Geometry

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

**现状：** ✅ `gdal.Geometry` 类已落地 —— `fromWkt`/`fromWkb`/`fromJson`、`toWkt`/`toWkb`/`toJson`、
`type`/`isEmpty`/`pointCount`/`area()`/`length()`/`envelope()`、`flattenTo2D`/`segmentize`/`swapXY`/
`transform`，以及按形状的访问器（`x`/`y`/`z`、`points()`、`rings()`/`exteriorRing`/`interiorRings`、
`children()`、`coordinates`）。上列**全部** GEOS 谓词、`distance`、`isValid`/`isSimple` 与集合运算
都已实现，再加 `makeValid`/`boundary`/`pointOnSurface`/`unaryUnion`/`concaveHull`/`normalize`/
`setPrecision`/`isRing`/`toGML`/`toKML`。**类族不做**（见「三个已定案的分歧」）：napi 无法表达
继承，按形状的访问器覆盖同样的能力；类族那层形状（含 `instanceof`）归兼容层。模块级的
`geometryToWkt` 等仍以 GeoJSON 收发，不变。

### A6. 算法与工具

| gdal-async | 我们 |
|---|---|
| `translate` / `warp` / `vectorTranslate`（+Async） | ✅ |
| `dem` / `demAsync` | ✅ `demProcess` |
| `buildVRT` / `buildVRTAsync` | ✅ `buildVrt` |
| `wrapVRT` | ✅ `translate(dest, ['-of', 'VRT'])`（或 `dataset.translateSync('', ['-of','VRT'])`），不另开门 |
| `reprojectImage` | ✅ |
| `rasterize` / `polygonize` / `contourGenerate` | ✅ |
| `sieveFilter` / `fillNodata` / `checksumImage` | ✅ |
| `suggestedWarpOutput` | ✅ |
| `calcAsync`（`gdal_calc.py` 替代） | ✅ `calcAsync(inputs, output, fn, options?)`，另加它底下的 `RasterMuxStream` / `RasterTransform`；回调名用本绑定的 `onProgress` |
| `addPixelFunc` / `createPixelFunc` / `toPixelFunc`（VRT 像素函数） | ✅ 已落地：Rust 侧 trampoline 池（GDAL 回调只给函数指针、不给名字）+ JS 侧函数表；另有 `createPixelFuncWithArgs` 与 `wrapVRT`。**同步读限定**：线程池读取会明确报错（否则要与 worker 持有的锁死锁） |
| `toDataType` / `fromDataType` | ✅ 收/发本绑定的字符串词汇（也接受 GDAL 拼写） |
| `decToDMS` | ✅ |

### A7. 多维模型与流

- `MDArray` / `Group` / `Attribute` / `Dimension` —— ✅ **已完成**，走 GDAL 自己的 C API：
  `Dataset.root`（`open(..., { multidimensional: true })`）开门，结构 / 属性 / CRS /
  `read` / `getView` / `getMask` / `asDataset` 俱全；反方向有 `band.asMDArray()`。
  `gdal.features().multidimensional === true`。集合形态（`root.arrays` 之类）不做，理由同 A3。
- 集合（`root.arrays` / `groups` / `attributes`）—— ❌ **非目标**：形状归 `compat`，同
  A2/A3 的集合条目；命名式入口（`openArray(name)` / `arrayNames()`）已覆盖同样的能力。
- `RasterReadStream` / `RasterWriteStream` —— ✅ 后由外壳（`index.js`）在分块读写之上补上：
  `band.createReadStream()` / `createWriteStream()`；`RasterMuxStream` / `RasterTransform`
  与它们之上的 `calcAsync` 也已补齐
- VRT 像素函数 —— ✅ `addPixelFunc` / `toPixelFunc` / `createPixelFunc` /
  `createPixelFuncWithArgs` / `wrapVRT`。GDAL 回调只给函数指针、不给名字，所以 Rust 侧用一组
  trampoline（编译期槽位）+ 一个 JS 分发表；**JS 函数只在同步读时被求值**，线程池读取明确报错
  （否则会与 worker 持有的锁死锁）。GDAL 自带的像素函数（`inv` / `sum` / …）经 `wrapVRT` 直接可用

### A8. 异步人体工学（影响服务端可用性的核心差距）

| 能力 | gdal-async | 我们 |
|---|---|---|
| 方法级异步 | ✅ `xxxAsync` + callback 双形态 | ✅ `xxxSync()` / `xxx(): Promise`（本绑定的命名约定，不引入 `Async` 后缀） |
| **异步 getter** | ✅ `rasterSizeAsync`、`srsAsync`、`colorTableAsync`… | ✅ 已落地 19 个（Dataset 3 + RasterBand 16）。理由与参考不同：我们这边是**等锁** —— 串行数据集上 getter 取独占锁，若此刻有异步读在跑，同步 getter 会把事件循环堵到读完；异步版把这段等待放到线程池。命名照参考保留 `Async` 后缀：getter 没有可改名的零参调用形式（`band.dataType` 是属性），「异步不带 Sync」这条规则没有对象可施 |
| **异步迭代器** | ✅ `for await (const f of layer.features)` | ✅ `for await (const f of layer.openCursor())`（外壳加的） |
| 同步迭代器 | ✅ `for (const f of layer.features)` | ✅ `featuresSync()` / `bands()` / `layers()` 返回数组，本来就同步可迭代 |
| **每数据集 I/O 队列** | 🟡 有 per-dataset mutex（`libuv` 线程池调度） | 🟡 **进程级 `RwLock`**：数据集走独占；`openThreadSafe()` 的读取走共享、真并行；无数据集的调用（CRS / 几何 / `gdal.fs` / 模块自省）也走共享 |
| 线程安全数据集 | ✅ 打开时 `'rt'` 标志 | ✅ `openThreadSafe()` |
| 事件循环阻塞告警 | ✅ `eventLoopWarning` | ✅ `gdal.eventLoopWarning`：`false` 关闭、`true` 用默认阈值（50 ms）、数字即阈值（本绑定扩展）。计时对象是「会碰数据集」的那几个类的**阻塞方法**（Dataset / RasterBand / BandOverview / Layer / FeatureCursor），经 `process.emitWarning` 以 `GdalEventLoopWarning` 发出 |

异步 getter 的取舍记录在 WS-4；每数据集队列与锁模型的关系记录在 Phase 2 与
[`docs/PARITY.md`](./docs/PARITY.md)。

---

## B. API 稳定性

### B1. 现状风险

| 风险 | 说明 |
|---|---|
| 风格未冻结 | 现在是 0.x，任何补全都可能顺手改命名，越晚冻结越贵 |
| 生成的 `binding.d.ts` | 61KB 自动生成，用户直接依赖它，但没有"这是契约"的声明 |
| 字符串即枚举 | `fieldType: 'String'`、`colorInterpretation: 'RedBand'`、`dataType: 'Float32'`——拼错只在运行时炸（`gdal.const` 已缓解：拼错变成一个可引用的名字） |
| ~~错误码只覆盖同步路径~~ | ✅ 已解决：异步错误现在也带 `err.code`（外壳把消息前缀提回字段），两条路径一致 |
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
   与 `gdal.features()`（`{ geos: true, mdArray: false, streams: true, compat: true }`）。
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
| Streams / MDArray / calcAsync | Streams 与 `calcAsync`（含 `RasterMuxStream` / `RasterTransform`）、MDArray 都已在主入口（A7）。compat 不重包装它们 | — |
| 同步迭代器 `Symbol.iterator` | 在 compat 里实现（也值得进自有 API） | 低 |

**这不是"两套 API 维护负担"**：compat 层只是适配器，不复制逻辑；自有 API 演进时
compat 层用测试锁住形状即可。它的价值是——**让 `gdal-async` 用户零成本试我们的包**，
而这是"无宿主依赖"这个卖点唯一能被验证的方式。

---

## C. 分阶段补全顺序

排序依据：**(用户影响 × 可行性) / 依赖**。

### C1. 先决决策：GEOS —— ✅ 已定：自行构建 + 静态链接（`geos_static`，默认开启）

**决策：GEOS 像 GDAL/PROJ 一样由构建过程自行获取并编译，静态链接进 `.node`，并进入
`bundled`（默认就有）。** 完整推理见 [`docs/GEOS.md`](./docs/GEOS.md)。要点：

- **先纠正一个直觉：`.node` 自己是动态库，并不能免除 LGPL 义务。** 该看的是 GEOS 相对
  `.node` 的链接方式 —— 把 GEOS 的机器码编进去就是静态链接，LGPL-2.1 §6 会要求提供"让用户把
  它与修改过的 GEOS 重新链接"的手段。动态链接（`gdal-src/geos`）确实能免除这项义务，但代价：
  ① **在 Windows/MSVC 上根本走不通** —— 这台机器上有的 GEOS 是 MinGW 的，其导入库 MSVC
  链接器用不了；② 需要把平台相关的共享库随包发出，并为每个平台的加载器找出它们的路径
  （Windows 的 `LoadLibraryExW` **不搜 addon 自身目录**，只能改 `PATH`；Linux/macOS 靠
  `$ORIGIN` / `@loader_path`）。六平台的加载器管道，只为省掉发布清单里的一项。
- 所以走 `gdal-src/geos_static`：`geos-src` 取回源码、CMake 编译，静态链进那份静态 GDAL，
  最终全在**一个** `.node` 里。分发模型完全不变（单个 `.node` + `assets/`），"零宿主依赖"成立。
- **许可义务落在"发布物"上，不落在源码上**：本仓库仍是 MIT；发布时附 GEOS 对应源码 + 重建说明
  （必要时附目标文件）即履行 §6。这是发布清单的一项，不是许可证变更。
- 代码层面：`gdal` crate 不暴露 GEOS 调用，谓词经 `gdal_sys` 的 `OGR_G_*` 直连，且**每个都先查
  `has_geos()`** —— 瘦身构建（无 GEOS）时给出"本构建没有 GEOS"的答复，而不是 `TypeError`；
  接口形状不变，变的只是答案，这正是 `features().geos` 存在的意义。

<details>
<summary>当初的三选一，以及动态/静态的取舍（留档）</summary>

| 方案 | 内容 | 评价 |
|---|---|---|
| **A. 不做** | 几何 API 只提供非 GEOS 子集；`features().geos === false` 时文档指向"用 PostGIS/GEOS 外部处理" | 成本最低，但几何能力远低于 `gdal-async` |
| **B. 自建 GEOS（**已选**）** | 由 `geos-src` 获取并编译 GEOS，静态链进 `.node`，默认开启 | 与 GDAL/PROJ 同一条路；分发仍是单个自包含产物。代价是 §6 发布材料 |
| ~~B′. 动态链接变体~~ | 默认包不带 GEOS；另发一个动态链接 GEOS 的变体 | 许可义务更轻，但 Windows/MSVC 不可行，且要为六平台写加载器管道 |
| **C. Rust `geo` crate 自实现** | 不依赖 GEOS | 语义与 GEOS 不一致，工作量大，不推荐 |

</details>

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

**单读者限制：评估结果（实测）。** GDAL 把读取位置放在**图层**上，所以同一图层同时只有一个读者。
缓解不是"给每个游标发一份位置"——GDAL 没有这个概念——而是**再开一个 dataset 句柄**：`open(path)`
同一个数据源一次，两个句柄各自按批推进、各自看完整层（两个游标在同一句柄上则会互相穿插，各自只看
到一部分）。另一条路是 `layer.getFeature(fid)`：随机访问，不移动位置，所以查一条不会打断正在读的
游标。顺带修掉一个真问题：`featuresSync()` / `features()` 此前从**当前位置**开始读，因此跟在游标
后面时会只拿到尾部（gdal crate 的 `FeatureIterator` 只在 drop 时倒带）——现在它们**先倒带**，
"整层读取"名副其实；读完仍把位置留在末尾（位置只有一个），之后那个游标会从头接着读。

**WS-4 · 异步人体工学** —— ✅ 已完成（下面标 ❌ 的都是**已定案的非目标**）
- ✅ `FeatureCursor` 的 `Symbol.asyncIterator`：napi 给不了生成类这个属性（`AsyncGenerator`
  够不到，见 CHANGELOG），所以由**外壳**（`index.js`）加上，读的仍是同一个 `read()`，
  以空批次为终点 —— 两种读法不可能不一致。`Dataset.bands/layers` 的异步迭代**不做**：
  它们返回的就是数组，数组本来就有同步迭代器，而给每次调用返回的数组现挂一个 async 迭代器，
  收益不抵那份怪异。
- ✅ **点数组的异步孪生**：`CoordinateTransform.transformPoints` 把整条扁平 `Float64Array` 搬到
  线程池上，于是上百万个坐标是一次调用，而不是调用方为了不堵事件循环手写的分块循环。`CoordTransform`
  不是 `Send`，所以任务把两个 CRS 的 WKT **连同轴序**一起带过去，在 worker 上重建 —— 丢轴序正是这一带
  最容易出的「坐标看着合理、位置却错」的静默故障，因此同步/异步共用同一个函数体，并有一条把「重建的
  转换」与「活的转换」在两种轴序下逐一对照的测试。同步版随之更名 `transformPointsSync`（规则第 1 条：
  阻塞版 `xxxSync()`）—— 包未发布，这次改名成本最低。
- ⚖️ **`OGR_G_Transform` 的原地路径：评估后不采纳。** gdal crate 有 `transform_inplace`，能把「克隆一个
  几何」这一次拷贝降到零；但 `Geometry` 是**值类型**（`flattenTo2D`/`segmentize`/`swapXY`/`transform`
  一律返回新对象），加一个原地方法会成为唯一的例外，而省下的只是那一次克隆 —— 与其它值操作同一量级。
  几何变换因此保持同步值语义；批量的入口是那个坐标数组，不是几何。
- ❌ 异步 getter（`rasterSize()`、`srs()`、`colorTable()`）：**与命名约定冲突** ——
  本 API 的规则是「阻塞版 `xxxSync()`、异步版 `xxx()`」，getter 没有 `xxxSync` 之分，
  加一个 `rasterSizeAsync()` 等于引入 `Async` 后缀，而那正是兼容层才用的拼法。
  而且它要解决的问题（gdal-async 的 per-dataset I/O 队列下"启动 I/O 后读同步 getter 会卡"）
  在这里形态不同：我们是一把全局锁，同步 getter 只是等锁。**记为设计取舍。**
- ❌ `eventLoopWarning`：诊断类的锦上添花，留给需要它的人提需求时再做。
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
- 只剩 A8 那一条：原生集合对象形态。
（Node Streams、波段代数、多维模型、`calcAsync`、VRT 像素函数、异步 getter 与
`eventLoopWarning` 后来都补上了，见 [`docs/PARITY.md`](./docs/PARITY.md)。）

### C3. 顺序与依赖

```
C1 (GEOS ✅=自建+静态) ┐
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
