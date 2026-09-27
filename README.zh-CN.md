# gdal-rs-napi

基于 Rust 的 [`gdal`](https://crates.io/crates/gdal) / [`gdal-sys`](https://crates.io/crates/gdal-sys)
crate、通过 [napi-rs](https://napi.rs) 暴露给 Node.js 的 GDAL 原生插件。

GDAL 与 PROJ 被**静态编译**进插件，PROJ/GDAL 的数据文件随 npm 包一起分发，
因此安装后的包**不依赖宿主机的 GDAL**。

> 英文文档见 [README.md](./README.md)（更完整），本文件覆盖同样的要点。
> 变更记录见 [CHANGELOG.md](./CHANGELOG.md)。

## 安装与使用

```js
const gdal = require('gdal-rs-napi')

gdal.version()          // { gdal: 'GDAL 3.12.1 "Chicoutimi", …', proj: '9.6.2' }
gdal.drivers().length   // 148

// 出问题时先跑这个：它会告诉你 CRS 数据库有没有被找到、PROJ 被指到了哪里
gdal.diagnostics()
// { epsg4326Resolves: true, crsDatabaseFound: true, projDataEnv: '.../assets/proj', … }
```

`index.js` 会自动调用 `configureDataPaths()`，把 PROJ/GDAL 指向包内的
`assets/proj` 与 `assets/gdal`。环境里已有的 `PROJ_DATA` / `GDAL_DATA` **永远优先**，
不会被覆盖。

## 光栅

```js
const dataset = gdal.openSync('dem.tif')
dataset.driver          // 'GTiff'
dataset.width, dataset.height, dataset.bandCount
dataset.geoTransform    // [x0, dx, rx, y0, ry, dy] 或 null
dataset.projection      // WKT 或 null

const band = dataset.band(0)   // 0-based（GDAL 内部是 1-based）
band.dataType           // 'Float32'
band.noDataValue        // -9999 或 null
band.size               // [宽, 高]
band.blockSize          // 驱动原生分块

// 按波段自身类型读原始字节（零拷贝 Buffer），不做转换
band.readPixelsSync({ x: 0, y: 0, width: 256, height: 256 })
// 或让 GDAL 在读的时候转换
band.readAsSync('Uint8')
// 降采样：resampling 取 nearest/bilinear/cubic/cubicspline/lanczos/average/mode/gauss
band.readPixelsSync({ outWidth: 128, outHeight: 128, resampling: 'average' })

// 每个读取方法都有异步孪生版，跑在 libuv 线程池上
await band.readPixels()

dataset.close()
```

读取返回的是**原始字节**，因为一个返回类型不可能同时是 `Float32Array` 和
`Uint16Array`。要看成分类型数组：

```js
const bytes = band.readPixelsSync()
const copy = Uint8Array.from(bytes)   // 复制一下，对齐问题就不存在了
const values = new Float32Array(copy.buffer, 0, copy.length / gdal.bytesPerSample('Float32'))
```

写入、创建、地理参考：

```js
const out = gdal.createSync('dem.tif', {
  driver: 'GTiff', width: 64, height: 64, bandCount: 1, dataType: 'Float32',
  // 驱动创建选项，原样透传给 GDAL
  options: { TILED: true, BLOCKXSIZE: 32, BLOCKYSIZE: 32, COMPRESS: 'DEFLATE' },
})
out.setGeoTransform([500000, 30, 0, 4600000, 0, -30])
out.setProjection(gdal.epsgToWkt(32633))
out.band(0).writePixelsSync(Buffer.from(new Float32Array(64 * 64).buffer))
out.close()
```

创建选项的名字是 **GDAL 自己的**，各驱动不同：GTiff 分块用 `BLOCKXSIZE`/`BLOCKYSIZE`，
而 COG 用 `BLOCKSIZE`。GDAL 对不认识的选项只会打一条 warning 然后忽略。

有些驱动实现了 `CreateCopy` 但**没有** `Create`（COG 就是典型），无法从零创建，
只能拷贝已有数据集：

```js
const source = gdal.openSync('dem.tif')
const cog = await source.createCopy('dem-cog.tif', 'COG', { COMPRESS: 'DEFLATE', BLOCKSIZE: 512 })
cog.close(); source.close()
// 用它自己的元数据验证：{ INTERLEAVE: 'BAND', COMPRESSION: 'DEFLATE', LAYOUT: 'COG' }
```

两个容易踩的点：`width`/`height` 是 GDAL 原样返回的，**只对栅格数据集有意义**
（矢量 GPKG 也会返回一个数字），用之前先看 `bandCount`；`IMAGE_STRUCTURE`
元数据挂在 **dataset** 上而不是 band 上。

## 统计与金字塔（overviews）

```js
const band = gdal.openSync('dem.tif').band(0)

// min / max / mean / stdDev。`force: false` 只读 GDAL 已有的缓存，没有就返回 null
const stats = await band.statistics()

// 指定区间与桶数的直方图
const histogram = await band.histogram({ min: stats.min, max: stats.max, buckets: 256 })

// 金字塔：让降分辨率读取不再逐像素扫
const dataset = gdal.openSync('dem.tif', { update: true })
dataset.band(0).overviewCount // 0
await dataset.buildOverviews()
dataset.band(0).overviewCount // 1024x1024 的栅格会建 3 层
```

几点值得知道：

- **`statistics()` 默认会真算**。大栅格上这等于把该波段完整读一遍 —— 所以有异步版本，也有
  `approx: true`（让 GDAL 借助 overview 求近似）。`{ force: false }` 是便宜的那条路：
  只报缓存，没有则 `null`。
- **`setStatistics()` 把统计量写回**，下一个读取者用 `{ force: false }` 直接拿到，不必再全波段扫一遍。
  以 update 方式打开时会写进文件（格式支持的话）；**只读**句柄也不会报错 —— GDAL 的 PAM 层会在栅格
  旁边生成 `<file>.aux.xml`，所以一个你以为只读的调用仍然可能留下文件。
- **`buildOverviews()` 是本绑定里最慢的调用**。设 `GDAL_NUM_THREADS=ALL_CPUS` 可让 GDAL
  并行计算各层，稍大的栅格值得加。
- **层数默认按 `gdaladdo` 的规则**：2 的幂，直到最小一层在较长边上小于 256 像素。要明确就传
  `levels`。构建是**增量**的，与 `gdaladdo` 一致 —— 已存在的层原地重算，其它层不动。
- **落在哪里取决于打开方式**：`{ update: true }` 写进文件内部；只读打开则生成旁边的外部
  `.ovr`。这就是 `gdaladdo` 与 `gdaladdo -ro` 的区别。
- **`resampling` 用 `gdaladdo` 的名字** —— `nearest`（默认）、`average`、`rms`、`gauss`、
  `bilinear`、`cubic`、`cubicspline`、`lanczos`、`average_magphase`、`mode`。拼错会直接报错
  并列出候选，不会丢给 GDAL。
- **GTiff 只支持一次性为所有波段建 overview**，`bands` 是为那些接受子集的驱动预留的透传。
- **`removeOverviews()` 删除整个金字塔** —— 与构建完全对称，就是一次调用版的 `gdaladdo -clean`。

## 坐标系（CRS）

```js
const wgs84 = gdal.SpatialRef.fromEpsg(4326)
const webMercator = gdal.SpatialRef.fromEpsg(3857)

wgs84.authority         // 'EPSG:4326'
wgs84.isGeographic      // true
webMercator.linearUnit  // { name: 'metre', factor: 1 }

// 转换建一次反复用：算转换管线才是贵的那部分
const toMercator = new gdal.CoordinateTransform(wgs84, webMercator)
toMercator.transformPoint(13.4, 52.5) // 柏林，单位米
toMercator.transformPoints(new Float64Array([13.4, 52.5, 2.35, 48.85]))
toMercator.transformGeometry(polygon) // 进 GeoJSON，出 GeoJSON
toMercator.transformBounds([13.0, 52.0, 13.8, 53.0])
```

**这里的坐标是 经度,纬度。传参之前请先读这一段。**

GDAL 3 把 `EPSG:4326` 读作 **纬度,经度**，而调用本身完全看不出这一点：按那个顺序，
`transformPoint(13.4, 52.5)` 返回的是一个看着完全合理的坐标 —— 13.4°N 52.5°E，那在亚丁湾，
不是柏林。GeoJSON、WKT 以及本包其它所有部分都是经度,纬度，所以这里构造的每个 `SpatialRef`
都用这个顺序（`axisMapping` 会如实报 `traditional`）；想用 GDAL 的读法就
`withAxisMapping('authority')`。

几点值得知道：

- **`fromDefinition` 什么都能收** —— 凡是 `gdalinfo` 认的 CRS 描述都行：`EPSG:4326`、WKT 字符串、
  PROJJSON、PROJ 串。`fromEpsg` / `fromWkt` / `fromProj4` 只是更明确的入口。
- **`equals` 比较的是定义本身，不是写法**：同一个 WGS 84 的两种 WKT 写法相等。
- **`identifyEpsg` 返回 Promise**，因为它要查 CRS 数据库。无法解析的描述会抛错；
  能解析但匹配不到的返回 `null`。
- **`dataset.spatialRef` / `layer.spatialRef`** 直接给出已打开对象的 CRS，没有则为 `null`。
  `createLayer` 现在也能收 `wkt` 了 —— 不是来自 EPSG 代码的 CRS 不再无处可用。
- **坐标转换是 2D 且同步的** —— 上百万个点请自行分块，别用一次调用把事件循环堵住。

## 矢量

```js
const dataset = gdal.openSync('roads.gpkg')
dataset.layerCount
const layer = dataset.layer(0)          // 也是 0-based
layer.name, layer.geometryType          // 'LineString' / 'MultiPolygon' / …
layer.featureCount                      // 数字，或 null（驱动无法在不全表扫描时回答）
layer.fields                            // [{ name, fieldType, width, precision }]
layer.extent                            // [minX, minY, maxX, maxY] 或 null
layer.spatialRefWkt

layer.featuresSync()                    // 整层物化成普通对象
layer.feature(3)                        // 按 fid 取一个，或 null
layer.setAttributeFilter('population > 1000')   // OGR SQL 的 WHERE；传 null 清除
layer.setSpatialFilterRect(minX, minY, maxX, maxY)
layer.clearSpatialFilter()
```

`featuresSync()` 返回的是**普通 JS 对象**，不是 GDAL 包装器：

```js
const [first] = layer.featuresSync()
first.fid          // 0，驱动没有 fid 时为 null
first.properties   // { name: 'alpha', population: 120 }；SQL NULL 就是 null
first.geometry     // { type: 'Point', coordinates: [10, 20] }，没有几何时 null
```

因为要素是**拷贝出来**的而不是包装的，即使之后关掉 layer 或 dataset 这些值依然有效。

几何工具函数收发 GeoJSON 对象：

```js
gdal.geometryTypeOf({ type: 'Point', coordinates: [10, 20] })  // 'Point'
gdal.geometryToWkt(point)                                      // 'POINT (10 20)'
gdal.geometryToWkb(point)                                      // Buffer
gdal.geometryFromWkt('POINT (10 20)')                          // GeoJSON 对象
```

写入：

```js
const dataset = gdal.createVectorSync('out.gpkg', 'GPKG')
const layer = dataset.createLayer({ name: 'places', geometryType: 'Point', epsg: 4326 })

layer.createFeature({ type: 'Point', coordinates: [10, 20] },
                    { name: 'alpha', population: 120, tags: ['a', 'b'] })
layer.createFeature(null, { name: 'gamma', population: null })  // 无几何，且写入一个 NULL

dataset.flushSync()
dataset.close()
```

`createFeature` 会为属性里出现的、尚不存在的字段自动建列，类型从值推断：
字符串 → `String`，整数 → `Integer64`，小数 → `Real`，布尔 → `Integer`。两个刻意的取舍：

- **`null` 和嵌套对象不建字段** —— 为无法表示的值凭空造一列，比忽略它更糟。
- **数组写成逗号连接的 `String`，不建列表字段**。因为不支持列表列的驱动（GPKG）
  会**接受**列表字段请求、把列建成标量，然后仍在 layer 定义里报告列表类型，
  于是列表 setter 会把 GDAL 内部的 `(2:a,b)` 形式写进去。已经存在列表类型的字段
  （比如从 GeoJSON 读回来的）依然按真正的列表写入。

值用**字段声明类型**对应的 setter 写入，而不是 JS 值的类型，所以 `Date` 字段收日期字符串、
`String` 字段收连接后的文本、数组写进整数列会明确报错而不是静默出错。

`updateFeature(fid, geometry, properties)` 只改你点名的字段，遇到不存在的属性会报错
（而不是加列），`geometry` 传 `null` 表示保持原样。`deleteFeature(fid)` 删掉一条要素，
`deleteLayer(name)` 按名字删掉整个图层（删除会让索引位移，所以名字才是安全的句柄）。
并非所有驱动都支持删除：GeoPackage 可以，Shapefile 不行，GDAL 会直接告诉你。

### 声明式 schema

推断只是便利，不是唯一方式。给 `createLayer` 传 `fields`，schema 就在任何要素写入之前存在，
而且每个类型是**选定**的而不是猜的：

```js
dataset.createLayer({
  name: 'places',
  geometryType: 'Point',
  epsg: 4326,
  fields: [
    { name: 'label', fieldType: 'String', width: 64 },
    { name: 'count', fieldType: 'Integer' },
    { name: 'tags', fieldType: 'StringList' },
  ],
})
```

声明的类型**总是**压过推断：`count: 5` 本来会被推成 `Integer64`；声明成 `StringList`
才能拿到真正的列表列，而不是推断写出的逗号连接文本。`width` / `precision` 交给驱动，
它可能保留也可能忽略 —— GeoPackage 保留 width 而丢弃 precision，因为 SQLite 没有定点数。
未声明的属性依然会照常被推断出字段，与声明的一起共存。

### 按批读取

`featuresSync()` 会把整层物化；`openCursor()` 改成一次读一批，于是图层的代价是**一批**而不是全部：

```js
const cursor = layer.openCursor({ batchSize: 1000 })
for (;;) {
  const batch = await cursor.read() // 在线程池上读
  if (batch.length === 0) break
  consume(batch) // { fid, properties, geometry }，与其它地方一致
}
```

每一批的内容与 `featuresSync()` 对这几行给出的结果完全相同，
所以这样的循环可以直接替换整层物化的调用。

两点要知道，这两点都是 GDAL 的形态、而不是本 API 的：

- **同一图层同时只能有一个读取者。** GDAL 把读取位置放在**图层**上 —— 这既是批次能续读的原因，
  也是第二个游标（或一次 `featuresSync()` 调用）会把第一个倒回开头的原因。
  请顺序读，并且不要混用两种读法。
- **`close()` 不碰 GDAL。** 其它任何读取都会重新倒带，所以把位置停在半途没有代价。

## 调用 GDAL 命令行工具（gdal_translate / gdalwarp / ogr2ogr）

三个工具各对应一次调用。`args` 就是**该工具自己的命令行参数**，GDAL 文档里的任何选项都能
直接粘贴过来，不必再学一套词汇。

```js
// gdal_translate -of COG -co COMPRESS=DEFLATE in.tif out.tif
await gdal.translate('out.tif', 'in.tif', ['-of', 'COG', '-co', 'COMPRESS=DEFLATE'])

// gdalwarp -t_srs EPSG:3857 -r cubic in.tif out.tif
await gdal.warp('out-3857.tif', ['in.tif'], ['-t_srs', 'EPSG:3857', '-r', 'cubic'])

// ogr2ogr -f GPKG out.gpkg in.geojson -nln places
await gdal.vectorTranslate('out.gpkg', ['in.geojson'], ['-f', 'GPKG', '-nln', 'places'])
```

每个都有 `Sync` 版本；源只有一个时还可以作为已打开数据集的方法调用。模块级的 `warp` 与
`vectorTranslate` 接受源列表，`gdalwarp` 会把它们合并：

```js
const dataset = gdal.openSync('in.tif')
dataset.warpSync('out-3857.tif', ['-t_srs', 'EPSG:3857', '-r', 'cubic'])
```

几点值得知道：

- **返回的是一个 `Dataset`**，也就是 GDAL 刚创建的那个，照常读；`close()` 负责落盘。
- **目标传空字符串表示内存**：`translateSync('', source, ['-of', 'MEM'])` 直接返回内存数据集。
- **`LAYOUT=COG` 要重新打开才看得到**。GDAL 交回的是刚写完的数据集，`LAYOUT` 是驱动**打开**
  一个成品 COG 时才报的，所以要断言这一点请重新打开文件。
- **参数写错会把参数原样回显**：`gdal_translate rejected these arguments: -not-a-real-option`，
  而不是像 `gdal` 自己的 `BuildVRTOptions` 那样——它从不检查 GDAL 是否返回了空 options 指针——
  直接崩在空指针上。
- **`ogr2ogr` 默认会替换目标图层，`-append` 才是追加。** 把 `GDALVectorTranslate` 指向一个
  同名图层已存在的目标，那个图层会被**替换** —— 不需要任何标志。`-overwrite` 是 ogr2ogr 自己的
  标志而不是 GDAL 的，所以本包自己实现它：**先把目标文件删掉**，因此那个文件里的**所有**图层都会
  一起消失。确实想要这个效果再用它；只是想"加进去"请用 `-append`。
- **`gdaldem` 也提供了**：数据集上的 `demProcess` / `demProcessSync`，或按路径的
  `gdal.demProcess`，支持 `hillshade`、`slope`、`aspect`、`color-relief`、`tri`、`tpi`、
  `roughness`。它们需要 geotransform，而计算坡度的那些需要以米为单位的 CRS。

### 进度回调与取消

每个程序调用都可以传最后一个可选参数 `onProgress`。它跑在 **JS 线程**上（真正的工作在 worker 上），
收到 `{ complete, message }`：

```js
await gdal.warp('out.tif', ['big.tif'], ['-t_srs', 'EPSG:3857'], (progress) => {
  process.stdout.write(`\r${Math.round(progress.complete * 100)}%`)
})
```

回调返回 `false` 即**取消**（这是 GDAL 一旦启动后唯一能被停下的方式），抛出的错误会明确说是被取消的，
而不是看起来像一次失败：

```js
try {
  await gdal.warp(dest, sources, args, (progress) => progress.complete < 0.5)
} catch (error) {
  if (error.message.includes('[GDAL_CANCELLED]')) console.log('已提前停止')
}
```

三点值得知道：

- **只有显式返回 `false` 才算取消**：返回 `undefined`（最常见的写法，比如只打日志）会继续执行。
- **从 GDAL 的视角看这个回调是同步的**，所以回调慢就会拖慢整个转换。只做记录，别在里面干重活。
- **不要在回调里回头调用本库**：worker 正在等你的答案，同时**攥着全局 GDAL 锁**，从回调里再调用会死锁。
  在里面报告进度可以，**不要读数据**。

同步入口（`*Sync`）**没有** `onProgress`，这是有意的：同步调用占着 JS 线程，而回调必须跑在那个线程上，
永远没有机会执行。

## 异步语义（用之前请读）

触碰 GDAL 的每个操作都会拿一把**进程级锁**：GDAL 的 last-error 是进程全局状态，
`gdal` crate 每次 FFI 后立刻读取并重置它，并发调用会互相串错错误信息。

所以异步 API 让 **event loop** 不被阻塞，但**仅靠它不会**让 GDAL 工作并行。
`open()` 出来的数据集上十个并发 `readPixels()` 和顺序执行十个耗时一样。

### 真并行：`openThreadSafe()`

GDAL ≥ 3.10 提供 `GDALGetThreadSafeDataset`，本绑定把它暴露了出来：

```js
const dataset = await gdal.openThreadSafe('big.tif')
const band = dataset.band(0)

// 这些是真正重叠执行的，不会在锁上排队
const tiles = await Promise.all(windows.map((window) => band.readPixels(window)))
```

这类数据集的**像素读取**走锁的**共享**侧而不是独占侧。其余操作仍然走独占侧，所以上面说的
全局错误状态串扰依然被排除在外。

```sh
node scripts/bench-parallel.mjs big.tif --concurrency 4
```

代价与边界：

- **只读、只栅格**。GDAL 的 thread-safe dataset 不含矢量图层，也不含多维 API。
  `writePixels`、`setProjection`、`setGeoTransform`、`setMetadataItem`、`flush` 以及所有图层
  访问都抛 `GDAL_BAD_ARGUMENT`——那些请用 `open()`。`createCopy` 和 `translate`/`warp` 系列
  是可用的：它们读源、写到别处。
- **用 `threadSafe` 自省**：`open()` 得到的是 `false`，`openThreadSafe()` 是 `true`。驱动完全
  不支持时**打开就会失败并指名驱动**，而不是悄悄退回串行。
- **并发上限由工作线程池决定**：Node 默认 4 条，所以除非启动 Node 前调大
  `UV_THREADPOOL_SIZE`，最多只有 4 个读取重叠。
- **文件描述符**：多数驱动并非原生线程安全，GDAL 会**每线程重开一次文件**，调高并发就会消耗
  fd——记得同时调大 `ulimit -n`。GTiff / COG（libtiff）是例外，也是最省的那种。
- **块缓存命中时并行没有收益**：如果读能由 GDAL 的块缓存直接满足，锁从来就不是瓶颈。
  `openThreadSafe()` 的价值出现在读很贵的时候：冷 I/O，或者解压。

`close()` 的行为与其它地方一致：之后的读取会失败，而**已经在进行中**的读取会在仍然存活的句柄上
正常跑完。

### 错误码

同步失败会把 `err.code` 设成稳定的记号（`GDAL_CPL_FAILURE`、`GDAL_BAD_ARGUMENT`、
`GDAL_MISSING_PROJ_DATA` 等），并把 GDAL 自己的 class/number 放进消息：`[CPLErr=3 #4] …`。

`napi::Task` 把错误类型写死成 `napi::Error<Status>`，所以**异步**方法设不了这个 code，
改为把同一个记号放在消息开头：`[GDAL_CPL_FAILURE] …`。需要按 `err.code` 分支时请用同步版。

## 示例

`examples/` 下有三个可直接运行的脚本（在仓库根目录运行，通过 `..` 加载包）：

```sh
node examples/gdalinfo.mjs path/to/anything.tif   # 迷你 gdalinfo，栅格/矢量都能看
node examples/to-cog.mjs in.tif out.tif COMPRESS=ZSTD
node examples/convert-vector.mjs roads.geojson roads.gpkg roads
```

## 预编译产物

CI 为每个平台构建一个自包含 tarball，推 `v*` tag 时挂到 GitHub Release 上。
**完全不发布到 npm**，直接装 release 资产：

```sh
npm install https://github.com/yjdyamv/gdal-rs-napi/releases/download/v0.1.0/gdal-rs-napi-0.1.0-darwin-arm64.tgz
```

每个 tarball 内含加载器、打包好的 GDAL/PROJ 数据和它自己的 `.node`，并声明了
`os`/`cpu`/`libc`，装到不匹配的机器上 npm 会直接拒绝。

| Rust target | 运行器 | 平台子包名 |
|---|---|---|
| `x86_64-pc-windows-msvc` | `windows-latest` | `win32-x64-msvc` |
| `aarch64-apple-darwin` | `macos-latest` (arm64) | `darwin-arm64` |
| `x86_64-unknown-linux-gnu` | `ubuntu-latest` | `linux-x64-gnu` |
| `aarch64-unknown-linux-gnu` | `ubuntu-24.04-arm` | `linux-arm64-gnu` |
| `x86_64-unknown-linux-musl` | `ubuntu-latest` | `linux-x64-musl` |
| `aarch64-unknown-linux-musl` | `ubuntu-24.04-arm` | `linux-arm64-musl` |

glibc/Windows/macOS 各条腿都跑在**对应架构的原生运行器**上（交叉编译静态 GDAL 不值得）。
两个 musl 目标标记为 `experimental`（`continue-on-error`）：它们通过 napi 的 zig
工具链交叉链接静态 C++ GDAL，是整条链路里最不确定的一环。Intel macOS 未构建。

那两条 musl 腿的测试跑在 `node:24-alpine` 容器里，而不是 runner 上：napi 的交叉工具链
把 musl **动态**链接，runner 上的 glibc Node 根本无法加载这样的 addon（一个进程里两个
libc）。容器也是更诚实的验证场所 —— 那里生成的 loader 会解析到 musl，跑的就是真产物，
而不是披着 musl 标签的宿主构建。

## 从源码构建

### 前置依赖

| 需要 | 说明 |
|---|---|
| Rust | ≥ 1.98（见 `Cargo.toml` 的 MSRV） |
| Node.js | ≥ 20.17 |
| CMake | ≥ 3.12；4.x 需要 `CMAKE_POLICY_VERSION_MINIMUM=3.5`，已写进 `.cargo/config.toml` |
| Ninja | **必需** |
| `sqlite3` 命令行工具 | **必需** —— PROJ 会调用它生成 `proj.db` |
| C/C++ 工具链 | MSVC（VS 2022+），macOS/Linux 用 clang/gcc |

```sh
# Windows
winget install SQLite.SQLite      # 或 choco install sqlite
winget install Ninja-build.Ninja
# macOS
brew install sqlite ninja cmake
# Debian/Ubuntu
sudo apt-get install sqlite3 ninja-build cmake g++
```

然后：

```sh
npm install          # 若设了 NODE_ENV=production 需加 --include=dev
npm run build        # release 构建 + 落盘数据文件
node -e "console.log(require('.').version())"
```

### 三个一定会踩的坑

**1. 必须把 MSYS2 / Cygwin / MinGW 从 `PATH` 里剔除。**

CMake 会从 `PATH` 推导候选前缀，于是发现 MSYS2 的 `ArrowConfig.cmake` —— 它
**改写了 `CMAKE_MODULE_PATH` 却不还原**，导致 GDAL 自己的 `include(GdalDriverHelper)`
找不到文件，整个 configure 直接失败：

```
CMake Error at frmts/zlib/contrib/infback9/CMakeLists.txt:13 (include):
  include could not find requested file: GdalDriverHelper
```

`scripts/build.mjs` 会自动剔除并打印剔掉了哪些目录。注意：进 VS Developer Shell
**修不了**这个问题 —— 它只是往 `PATH` 前面插 VS 路径，MSYS2 仍在里面。

这也是 `sqlite3` 必须来自 MSYS2 之外的原因：那个前缀必须离开 `PATH`，
而 MSYS2 的 `sqlite3.exe` 恰好住在里面（它还依赖同目录的 `libsqlite3-0.dll`）。

**2. 生成器必须是 Ninja**（已写在 `.cargo/config.toml`）。

`cmake-rs` 会传 `--parallel N`，但在 Visual Studio 生成器下这只等价于 MSBuild 的
`/m:N`，而 `/m` 只在**项目之间**并行。PROJ 和 GDAL 各自是**一个巨型 vcxproj**
（GDAL 侧 `proj.vcxproj` 一个文件里就有 217 个 `ClCompile`），生成的工程里没有 `/MP`，
于是 cl 一次只编译一个翻译单元 —— 实测 16 线程机器上**只有 1 个 cl.exe**。
Ninja 是按翻译单元并行的。

**3. 只用 `--release`，并且不要裸跑 `cargo`。**

- debug 是另一套 `target/` 目录，一次误操作就是重新编译整个 PROJ + GDAL。
- `napi build --platform` 会传 `--target <主机三元组>`，产物在
  `target/<triple>/release`，**不是** `target/release`。想单独类型检查/跑单测就带上同样的
  `--target`：

  ```sh
  cargo check --release --target x86_64-pc-windows-msvc
  cargo test  --release --target x86_64-pc-windows-msvc --lib
  ```

- `rust-analyzer` 会跑 `cargo check`，而它也会触发 gdal-src 的构建脚本 ——
  等于第三份完整 PROJ/GDAL 编译。等第一次构建跑完再信编辑器的报错。

### 实际编译了什么

| 组件 | 设置 |
|---|---|
| GDAL | 3.12.1，静态，`GDAL_USE_INTERNAL_LIBS=ON`，`GDAL_USE_EXTERNAL_LIBS=OFF` |
| PROJ | 9.6.x，`bundled_proj`，静态 |
| 驱动 | `gdal-src/all_drivers` —— 共 148 个，见下文 |
| GEOS | **不链接** —— LGPL，静态链接会让整个产物变成 LGPL |

因为 `gdal-src` 不点名就关闭所有驱动，Cargo 的 `bundled` feature 列表**就是**发布的驱动集合 ——
现在它写的是 `gdal-src/all_drivers`，也就是那个 crate 能构建的全部。

共注册 **148 个驱动**，`drivers()` 是权威列表。在支撑 GTiff/COG 的内部
libtiff / libgeotiff / libjpeg / libpng 之外，还包括：HDF5 与 netCDF（连同它们所需的 HDF5，
全部静态链接）、curl 系的网络驱动（WMS、WMTS、WCS、OGCAPI、PLMOSAIC、Carto、Elasticsearch、
NGW、AmigoCloud）、PostgreSQL 与 PostGIS、GRIB、STACIT/STACTA、FlatGeobuf、
GeoJSON / GeoJSONSeq / TopoJSON / ESRIJSON、GPKG、SQLite、OpenFileGDB、ESRI Shapefile、
MapInfo、DXF、DGN、CAD、S57、VDV、VFK、CSV、GTFS、Selafin、KMLSUPEROVERLAY、PGDUMP，
以及一长串各国测绘与科学数据格式。

**故意不含**的：

- **GEOS**，以及它实现的那批 OGR 几何运算 —— `ST_Intersects`、`ST_Buffer`、`-simplify` 等。
  GEOS 是 LGPL，静态链接它会让整份产物的许可证改变。它在 `gdal-src` 里是独立 feature，
  想改可以改，但那时你发布的就不再只是 MIT 了。
- **需要本构建未链接的 XML 库的格式** —— KML、GML、GPX、GMLAS、LIBKML、XLSX/XLS、DWG 等 ——
  以及依赖厂商 SDK 的 FileGDB / Oracle / MySQL，和 JPEG2000 / WebP / HEIF / AVIF 系列。
- **`PDS`**，这是本包唯一完全无法提供的驱动：`gdal-src` 发布的 crate 里没有
  `frmts/pds/data`，打开它会让 GDAL 的 configure 直接失败。`all_drivers` 把它排除掉正是这个原因。

以上全部静态链接，所以装好的包依然**不需要宿主机有任何 GDAL**。代价是体积：
`.node` 约 35 MB（131 驱动时是 28 MB），tarball 压缩后约 15 MB（12.7 MB），
加上几分钟额外的构建时间。想瘦身，就把 `bundled` 里的 `gdal-src/all_drivers` 换成你真正需要的
那些 `gdal-src/driver_*`。

`openThreadSafe()` 需要 GDAL ≥ 3.10，bundled 构建满足。链接 3.10 以前的系统 GDAL
（`--no-default-features`）**仍然能编译**，只是没有这个方法：`build.rs` 读取 `gdal-sys`
报告的版本号，仅在 `gdal::ThreadSafeDataset` 存在时才打开它。

## 已知缺口

CRS 只做到点与包围盒的变换：几何对象本身不参与变换，`CoordTransformOptions`（指定转换管线、
精度目标）没有暴露，且变换是同步的 —— 上百万个点需要调用方自行分块。

读图层可以按批读（游标），但那是游标而不是 JS 的 async iterator；且 GDAL 的读取位置在图层上，
同一图层同时只能有一个读取者。`translate`/`warp`/`ogr2ogr`/`gdaldem` 都没有进度回调；
直方图只能读，不能写回数据集（统计量可以，见 `setStatistics()`）。

Intel macOS 与 32 位目标未构建。

## 许可证

MIT。GDAL 与 PROJ 均为 MIT/X11；详见 [LICENSE](./LICENSE)。
