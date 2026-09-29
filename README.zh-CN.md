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

// 这个构建到底是什么？BUILD_INFO 只列出编译进来的东西，
// 没编译进来的能力是「键不存在」，而不是 "NO"。
gdal.info()
// { releaseName: '3.12.1', releaseDate: '20251212', versionNum: '3120100',
//   build: { OGR_ENABLED: 'YES', PROJ_BUILD_VERSION: '9.6.2', … }, driverCount: 148 }

// “本绑定能做什么”是另一个问题：`features()` 总是把所有开关都答全，
// 不必靠“调用一个方法再捕获 TypeError”来探测。
const features = gdal.features()
// { geos: false, threadSafe: true, multidimensional: false, streams: false }

gdal.apiVersion // '0.1.0' —— 绑定的版本，不是 `version().gdal`
```

`index.js` 会自动调用 `configureDataPaths()`，把 PROJ/GDAL 指向包内的
`assets/proj` 与 `assets/gdal`。环境里已有的 `PROJ_DATA` / `GDAL_DATA` **永远优先**，
不会被覆盖。

`diagnostics().geosAvailable` 回答 OGR 的几何谓词（`ST_Intersects`、`ST_Buffer`、
`-simplify`）能不能用。答案是可以：GEOS 由构建过程自行获取、编译并静态链接，和 GDAL 本身
一样 —— 见「要素对象」一节与 `docs/GEOS.md`。

## 常量

`gdal.const` 把本绑定**已经在用**的那几套字符串词汇冻结成表，于是名字可以直接引用而不必重敲：

```js
gdal.const.FieldType.Integer64         // 'Integer64'
gdal.const.ColorInterpretation.RedBand // 'RedBand'
gdal.const.Resampling.Average          // 'average'
gdal.const.OverviewResampling.Rms      // 'rms'
gdal.const.SqlDialect.SQLITE           // 'SQLITE'
```

它们是本 API **返回并接受**的字符串，不是 GDAL 的数字枚举码：`band.dataType` 是
`'Float32'`，`layer.fields[0].fieldType` 是 `'String'`。这些表是冻结的，且有一条测试逐值
核对运行时真正使用的拼写，因此两者不会漂移。

`Resampling` 与 `OverviewResampling` 是两套词汇，因为 GDAL 本来就是两套。像素读取（以及
`warp` / `reprojectImage`）用 `Resampling`，那里最近邻是 `nearestneighbour`；
`buildOverviews({ resampling })` 用 `OverviewResampling`，那里是 `nearest`，并且多出
`rms` / `average_magphase` / `none`。`none` 不是核函数——它是**删除**金字塔的方式。

## 配置与 GDAL 的最后错误

`gdal.config` 是 GDAL 自己的选项存储——也就是 `--config NAME=VALUE` 与 `GDAL_*` /
`CPL_*` 环境变量写入的同一处：

```js
gdal.config.set('GDAL_NUM_THREADS', 'ALL_CPUS') // 例如让 buildOverviews 并行
gdal.config.set('CPL_CURL_VERBOSE', 'YES')      // 以及 curl 系列驱动
gdal.config.get('GDAL_NUM_THREADS')             // 'ALL_CPUS'
gdal.config.get('NOT_SET_ANYWHERE')             // null
gdal.config.get('NOT_SET_ANYWHERE', 'fallback') // 'fallback'
gdal.config.set('GDAL_NUM_THREADS', null)       // 清掉
```

两点值得知道：

- **它是进程级的，活过这一次调用。** 在这里设的值会盖过环境变量，直到被清除或进程退出。
- **`get` 能区分“没设”和“空”。** GDAL 没有“空值”这种选项值，所以没人设过的键读出来是
  `null`，或者是你传进去的默认值。正因如此，这里用的是 C 函数，而不是那层会把两者合并的
  封装。

`gdal.lastError()` 返回 GDAL 最近一次错误——`class`、`number`、`message`——没有则 `null`：

```js
const dataset = gdal.createSync('out.tif', {
  driver: 'GTiff', width: 4, height: 4, bandCount: 1,
  options: { NOT_A_REAL_OPTION: 'x' },  // GTiff 打个 warning 就继续了
})
gdal.lastError()
// { class: 2, number: 6,
//   message: 'driver GTiff does not support creation option NOT_A_REAL_OPTION' }
```

两点需要知道：

- **它是给“没有变成异常”的错误用的。** 驱动打条 warning 然后照常跑完，正是它的用武之地；
  抛出的异常消息里不会有这条。
- **被抛出的失败在这里已经没了。** Rust 的 `gdal` crate 在构造错误时会读取并**重置** GDAL
  的错误状态，所以你 catch 到之后再调 `lastError()` 得到的是 `null`——那条错误的记录是
  `err.code` 与 `err.message`，其中 code 命名的就是这里报告的同一个 `CPLErr` class
  （`GDAL_CPL_FAILURE` 即 class 3）。

## 驱动（Driver）

驱动是**对象**，不是名字。`gdal.driver(name)` 是不必遍历列表的查找，本 build 没有的驱动返回 `null`：

```js
const gtiff = gdal.driver('GTiff')

gtiff.name                    // 'GTiff'
gtiff.longName                // 'GeoTIFF'
gtiff.fileExtensions()        // ['tif', 'tiff']
gtiff.metadata().DMD_MIMETYPE // 'image/tiff'

// “这个 build 能不能做？”不必试就知道。名字不认得时返回 false 而不是抛：
// 这是一次提问，而“不能”也是它的答案之一。
gtiff.testCapability('DCAP_CREATE')     // true
gtiff.testCapability('DCAP_VECTOR')     // false —— 纯栅格驱动

// `gdalinfo --format GTiff` 打印的那份 XML：每个创建选项、类型与默认值。
// 这是把选项名**查出来**而不是猜出来的方式。
gtiff.creationOptionList()
```

`gdal.drivers()` 返回的也是这些对象（按短名排序），所以
`gdal.drivers().map((d) => d.name)` 与它返回普通记录时完全一致。

`dataset.driver` 同样是这个对象。`dataset.driver.name` 就是短名，而
`String(dataset.driver)` / `` `${dataset.driver}` `` 读出来仍然是那个短名：

```js
dataset.driver.name                     // 'GTiff'
dataset.driver.testCapability('DCAP_CREATE')
```

`open()` 接受 **`drivers` 白名单**，于是本该被别的驱动接管的文件会直接失败，而不是悄悄当成
另一种格式打开 —— 而且失败信息里会点名试过的驱动：

```js
gdal.openSync('features.geojson', { drivers: ['GeoJSON'] })  // 通过
gdal.openSync('features.geojson', { drivers: ['GTiff'] })    // 抛错
gdal.driver('GeoJSON').openSync('features.geojson')          // 同一种限定
```

`Driver.open` / `Driver.openSync` 与 `Driver.create` / `Driver.createSync` 是同样几个调用，
只是驱动已经写死，不可能传错。`Driver.createCopy` / `createCopySync` 对 `CreateCopy` 同理 ——
这是通向 COG 这类「只实现 CreateCopy、不实现 Create」的驱动的路：

```js
gdal.driver('COG').createCopySync('out.tif', source, { COMPRESS: 'DEFLATE' })
```

## 文件 —— 内存与虚拟文件系统

GDAL 的每个路径本来就走一层虚拟文件系统，`gdal.fs` 就是够到它的那几个 `VSI*` 调用：
同一份代码能读普通路径、`/vsimem/`（内存）、`/vsizip/`（压缩包内）和 `/vsicurl/`（HTTP），
不需要事先知道是哪种。

```js
gdal.fs.writeFile('/vsimem/data.tif', bytes)
gdal.fs.exists('/vsimem/data.tif')   // true
gdal.fs.stat('/vsimem/data.tif')     // { size, isFile, isDirectory, modifiedMs }
const bytes = gdal.fs.readFile('/vsimem/data.tif')

gdal.fs.mkdir('/tmp/scratch')
gdal.fs.readDir('/tmp/scratch')      // ['a.txt', 'b.txt']，不含 '.' 和 '..'
gdal.fs.unlink('/vsimem/data.tif')
gdal.fs.rmdir('/tmp/scratch')
```

这一组是同步的，而且是刻意的：每次调用要么是内存拷贝，要么是本地系统调用。例外是
`/vsicurl/` —— 一次网络往返，会卡住事件循环 —— 那种情况请用跑在线程池上的 `open(url)`。
文件不存在不算错误（`exists` 是 `false`，`stat` 是 `null`）；被要求「改点什么」的调用才会抛。
另外 `/vsimem/` 底下并不是真的文件系统：那里的路径只是个不透明名字，所以
`writeFile('/vsimem/anything/nested.bin', bytes)` 不需要任何目录先存在。

**`open()` 除了路径也能收 `Buffer`**，这是「数据本来就没有文件」时的入口：

```js
const dataset = gdal.openSync(bytes)   // 或 await gdal.open(bytes)
dataset.driver.name                    // 'GTiff' —— 从内容嗅探出来的
dataset.path                           // '/vsimem/gdal-rs-napi-1234-0.bin'
```

这些字节会写进一个 `/vsimem/` 文件，而那个文件**就是**数据集的 `path` —— 内存里改过的
数据正是这样拿回来的（必须在数据集关闭之前）：

```js
const dataset = gdal.openSync(bytes, { update: true })
dataset.band(0).fill(9)
dataset.flushSync()                     // 在此之前脏块还在 GDAL 手里
const edited = gdal.fs.readFile(dataset.path)
dataset.close()                         // 这一步会把那个文件 unlink 掉
```

字节没有文件名，所以格式由 GDAL 嗅探内容判定：GTiff、PNG、JPEG、VRT、GeoJSON、GPKG
都能自报家门；只认扩展名的驱动认不出来 —— 那就用
`gdal.fs.writeFile('/vsimem/data.tif', bytes)` 再 `open('/vsimem/data.tif')`。

## 光栅

```js
const dataset = gdal.openSync('dem.tif')
dataset.driver.name     // 'GTiff' —— Driver 对象，见「驱动」
dataset.width, dataset.height, dataset.bandCount
dataset.rasterSize      // { width, height }，同一对值打包
dataset.description     // 对文件而言就是文件名
dataset.getFileList()   // 需要一起带走的东西；MEM 是 []
dataset.geoTransform    // [x0, dx, rx, y0, ry, dy] 或 null
dataset.projection      // WKT 或 null

const band = dataset.band(0)   // 0-based（GDAL 内部是 1-based）
band.dataType           // 'Float32'
band.noDataValue        // -9999 或 null
band.size               // [宽, 高]
band.blockSize          // 驱动原生分块

// 格式可以携带的波段元数据。`id` 是 GDAL 的 1-based 波段号，
// 而上面的 `index` 是本绑定 0-based 的约定。
band.id                 // 1
band.description        // 自由文本，或 null
band.unitType           // 例如 'metre'，或 null
band.scale              // raw * scale + offset 才是真实值
band.offset             //   …… 格式不带这两个时是 null
band.readOnly           // 跟随数据集的打开方式
band.minimum            // GDAL 的缓存：statistics() 之前是 null
band.maximum
band.categoryNames      // 以像素值为下标的标签，没有则 []

// …… 上述每一项都可以写回，格式支持的话波段元数据就不再是只读的。
band.setScale(2.5)
band.setOffset(10)
band.setUnitType('metre')
band.setDescription('elevation')
band.setCategoryNames(['water', 'land'])

// 字符串型 setter 用 `null` 清除，分类名用 `[]` 清空。
// scale / offset 没有这种形式 —— GDAL 的 setter 只收数字，
// 所以 `0` 就是一个普通取值，而不是回到 `null` 的办法。
band.setUnitType(null)
band.setDescription(null)
band.setCategoryNames([])

band.fill(0)            // 整条波段写同一个值

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

小问题就不必摆一个 options 对象了：

```js
band.getPixel(3, 4)                  // 一个采样值，返回 number
band.setPixel(3, 4, 7)

// 与 readPixelsSync 相同的窗口，只是写成四个数字
band.readValues(0, 0, 4, 4)
band.writeValues(0, 0, 4, 4, bytes)

// GDAL 自己的 I/O 单位：包含该点的那一块，并按波段范围裁剪
band.readBlock(300, 200)
band.writeBlock(300, 200, bytes)
```

读越界会报错并指出是哪个窗口，不会悄悄返回 0。`readBlock` 给的是「该块的矩形按波段裁剪」
之后的范围，所以在右、下边缘会比 `blockSize` 小 —— GDAL 自己的块读会给那些位置补值，
而文件里从来没有的值不值得交给 JS。这两个都返回字节，原因同上。

要处理大到放不进内存的栅格，就一条一条地走：

```js
const strips = band.readChunksSync({ rows: 64 }, (chunk) => {
  consume(chunk.data, chunk.x, chunk.y, chunk.width, chunk.height)
  return true          // 返回 false 就停下
})
```

`rows` 默认取该带的块高 —— 也就是 GDAL 反正要读的那一条；每一条都是完整的，不会是半条。
回调在事件循环上、两次读之间执行，它的返回值就是背压 —— 所以真正耗时的走法应该放进 worker。
（async iterator 那条路可以 `for await`，但需要 napi 的 async generator 支持，这个版本没有公开；
`readChunksSync` 就是它剩下的形态。）

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

`scale` 与 `offset` 决定了一个波段样本的真实含义——`raw * scale + offset` 才是物理值——
所以对 DEM 或反射率数据做任何计算前先读它们，否则读到的只是一堆整数。`minimum` /
`maximum` 是 GDAL 的**缓存**而不是计算：在 `statistics()` 跑过之前（或打开一个自带统计量的
格式之前）是 `null`。`readOnly` 跟随数据集的访问模式，因为波段自己没有访问模式。

GDAL 有三个栅格算法可以直接作用在波段上：

```js
band.checksumSync()                    // gdalinfo 打的那个 16 位指纹
band.checksumSync({ x: 0, y: 0, width: 256, height: 256 })  // 也可以只算一个窗口
await band.fillNoData()                // 用邻域把 no-data 像素填上
await band.sieveFilter({ threshold: 10 })  // 丢掉小于 10 像素的连通区
```

每个都有 `Sync` 孪生版。**`fillNoData` 与 `sieveFilter` 是原地修改**，所以数据集必须可写；
`fillNoData` 还要求波段有 no-data 值，没有就直说，而不是猜哪些像素是洞。**`checksum` 会拒绝
`resampling` / `outWidth` / `outHeight`**：它是"样本原样"的指纹，重采样进去只会让数字变了而已。

第四个是把几何烧进数据集：

```js
const square = { type: 'Polygon', coordinates: [[[2, 2], [6, 2], [6, 6], [2, 6], [2, 2]]] }
dataset.rasterizeSync([square], { burnValues: [1] })
await dataset.rasterize([square], { burnValues: [1], options: { ALL_TOUCHED: true } })
```

`burnValues` 是"每个几何一个值"，按位置对应；`bands` 用 **0-based** 下标挑波段（默认第一个）。
`options` 里其余的键都是 GDAL 自己的选项名（`ALL_TOUCHED`、`MERGE_ALG`、`INIT_DEST`），原样透传。
**它不做重投影**：几何必须已经在栅格自己的坐标系里，要挪位置用 `warp`。

第五个是反方向，把波段的值写成多边形：

```js
raster.band(0).polygonizeSync(layer)   // 4 连通，写进 `DN` 字段
await raster.band(0).polygonize(layer, { connectedness: 8, fieldName: 'value' })
```

每个"同值的连通区"出一个多边形，写进 `fieldName` 指定的字段（默认 `DN`）；图层没有这个字段就建一个
—— 浮点波段建 `Real`，其余建 `Integer`，因为字段类型必须和样本类型对得上。`connectedness` 取 4 或 8。
这个图层通常在**另一个**数据集里（和波段不是一个），完全没问题：两者在同一把锁下同时握住，图层的
数据集必须可写。

第六个是从栅格表面画等高线，也就是 `gdal_contour`：

```js
band.contourGenerateSync(layer, { levels: [0, 100, 200, 300] })
await band.contourGenerate(layer, { interval: 50, base: 0, idField: 'id' })
```

`levels` 和 `interval`（可带 `base`）二选一，不能都给。高程写进 `elevField`（默认 `ELEV`）；
想要每条线一个 id 就给 `idField` 起个名 —— 两个字段图层没有就会被建出来。波段需要有 geotransform，
而**图层**才携带 CRS，所以线出来是在图层自己的坐标系里。

而当重投影本身就是目的，而不是去调一个外部命令时 —— 先问它会产出什么，再产出：

```js
const { geoTransform, width, height } = raster.suggestedWarpOutputSync({
  dstWkt: gdal.epsgToWkt(3857),
})

const dest = gdal.createSync('warped.tif', {
  driver: 'GTiff', width, height, bandCount: raster.bandCount, dataType: 'Float32',
})
dest.setGeoTransform(geoTransform)
dest.setProjection(gdal.epsgToWkt(3857))

await raster.reprojectImage(dest, { dstWkt: gdal.epsgToWkt(3857) })
```

`setProjection` 也能直接收 `SpatialRef`，手里已有的 CRS 不必再绕回 WKT 一次：
`dest.setProjection(gdal.SpatialRef.fromEpsg(3857))`。

`suggestedWarpOutput` 就是 `gdalwarp` 在动任何像素之前算的那笔账 —— 尺寸、geotransform
和 `extent`，所以它也是「输出会有多大」的答案。`reprojectImage` 是 `GDALReprojectImage`：
把一个已打开的数据集重投影进另一个**必须已经存在**的数据集 —— 这两个是一对。两者的
`srcWkt` / `dstWkt` 都能给出或覆盖两个 CRS，所以没有投影信息的数据集也能用；`resampling`
收 `nearest`（默认，与 `gdalwarp` 一致）、`bilinear`、`cubic`、`cubicspline`、`lanczos`、
`average`、`mode` —— 没有 `gauss`，那是 `RasterIO` 的核，重投影不收。

两个容易踩的点：`width`/`height` 是 GDAL 原样返回的，**只对栅格数据集有意义**
（矢量 GPKG 也会返回一个数字），用之前先看 `bandCount`；`IMAGE_STRUCTURE`
元数据挂在 **dataset** 上而不是 band 上。

## 统计与金字塔（overviews）

**`band.overviews`** 是波段已有的金字塔：每层一个对象，带 `index`、`size`、`dataType`，
以及 `readSync()` / `read()` 读取该层自己的像素。这个 getter 每次都去问 GDAL，所以波段对象
建好之后才建出来的层也看得到。

```js
dataset.buildOverviewsSync({ levels: [2, 4] })

const [first] = band.overviews
first.size          // 16x16 的波段这里是 [8, 8]
first.readSync()    // 真正存下来的那次抽样，按它自己的尺寸读
```

这与 `readPixels({ outWidth, outHeight })` 不是一回事：后者是让 GDAL 自己**挑**一层并从中
重采样；直接读某一层拿到的是实际记录下来的那一次抽样。

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
- **直方图是同一对**。`histogram()` 负责计算；`defaultHistogram()` 读已存的，`setDefaultHistogram()`
  写入，因此 `band.setDefaultHistogram(await band.histogram({ min, max, buckets }))` 就是完整的往返，
  之后任何读取者都不再为它付代价。`defaultHistogram(true)` 让 GDAL 在没存过时现算一个 —— 那会读
  整个波段，所以默认是 `false`。
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
layer.fields                            // 每个字段的完整定义，见下
layer.field('population')               // 按名取一个，或 null
layer.extent                            // [minX, minY, maxX, maxY] 或 null
layer.spatialRefWkt

layer.featuresSync()                    // 整层物化成普通对象
await layer.features()                  // 同一次读取，但不在事件循环上
layer.feature(3)                        // 按 fid 取一个，或 null
layer.setAttributeFilter('population > 1000')   // OGR SQL 的 WHERE；传 null 清除
layer.setSpatialFilterRect(minX, minY, maxX, maxY)
layer.setSpatialFilter({ type: 'Polygon', coordinates: [ring] })  // 任意几何
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

### 要素对象

`feature(fid)` 与 `featuresSync()` 返回的是普通数据。想要带方法的形式时，`getFeature(fid)`
返回同一条要素的对象：

```js
const feature = layer.getFeature(3)     // 或 null
feature.fid                             // 3
feature.geometry                        // GeoJSON，没有几何则 null
feature.fields.get('population')        // 4500
feature.fields.has('nope')              // false
feature.fields.set('population', 4600)  // 直接写穿
feature.fields.toObject()               // { name: 'beta', population: 4600 }
feature.toObject()                      // feature(3) 返回的那份普通记录
```

每一次读写都会回到图层，因此没有需要保持同步的本地副本，也没有会忘记调用的 `save()` ——
`fields.set` 就是 `updateFeature(fid, null, { population: 4600 })` 那次写。

`layer.defn` 把图层的 schema 收进一个对象 —— `name`、`geometryType`、`geometryColumn`、
`fidColumn`、`fieldCount`、`fields` —— `feature.defn` 返回的是同一个对象。

几何工具函数收发 GeoJSON 对象：

```js
gdal.geometryTypeOf({ type: 'Point', coordinates: [10, 20] })  // 'Point'
gdal.geometryToWkt(point)                                      // 'POINT (10 20)'
gdal.geometryToWkb(point)                                      // Buffer
gdal.geometryFromWkt('POINT (10 20)')                          // GeoJSON 对象
gdal.geometryFromWkb(buffer)                                   // GeoJSON 对象
```

上面是普通数据形式的工具函数。`gdal.Geometry` 是同一个几何的**对象**形式，
用于不想每次都绕回 JSON 的度量与变换：

```js
const { Geometry } = gdal

const square = Geometry.fromWkt('POLYGON ((0 0, 10 0, 10 10, 0 10, 0 0))')
square.type        // 'Polygon'
square.area()      // 100
square.length()    // 40
square.envelope()  // { minX: 0, minY: 0, maxX: 10, maxY: 10 }
square.toJson()    // 就是要素 `geometry` 会带的那份 GeoJSON

// 三种编码都能构造 —— 包括要素身上那份 GeoJSON。
Geometry.fromJson(record.geometry)
Geometry.fromWkb(gdal.geometryToWkb(point))

// 变换返回**新**几何；手里的那个永远不变。
Geometry.fromWkt('POINT (1 2 3)').flattenTo2D().toWkt()   // 'POINT (1 2)'
Geometry.fromWkt('LINESTRING (0 0, 0 10)').segmentize(1)  // …pointCount 为 11
Geometry.fromJson(point).transform(gdal.SpatialRef.fromEpsg(4326), gdal.SpatialRef.fromEpsg(3857))
```

分形状的访问器只对自己的形状作答，其他形状一律 `null`，所以不必先问 `type` 就能读：

```js
Geometry.fromWkt('POINT (3 4)').x                     // 3
Geometry.fromWkt('POINT (3 4)').z                     // null —— 二维点没有 z
Geometry.fromWkt('LINESTRING (0 0, 1 1)').points()    // [[0, 0], [1, 1]]
Geometry.fromWkt('POLYGON ((…), (…))').exteriorRing   // 外环
Geometry.fromWkt('POLYGON ((0 0, 1 0, 1 1, 0 0))').interiorRings  // [] —— 没有洞
Geometry.fromWkt('MULTIPOINT ((0 0), (1 1))').children().map((p) => p.x)  // [0, 1]
```

`children()` 返回的是 `Geometry` 对象（拷贝，各自独立可用）。这里**没有** `Point` / `Polygon`
子类：我们的几何就是单一类，访问器按形状作答，`type` 告诉你它是哪种形状。

几何自身不带 CRS，所以 `transform` 两端都要点名 —— 读出来的要素用图层的
`spatialRefWkt` 当 `from`。

而且**每个收几何的写入接口两种形状都收**，不需要手工转换：

```js
layer.createFeature(Geometry.fromWkt('POINT (1 2)'), { name: 'a' })
layer.createFeature({ type: 'Point', coordinates: [3, 4] }, { name: 'b' })
layer.setSpatialFilter(Geometry.fromWkt('POLYGON ((0 0, 10 0, 10 10, 0 10, 0 0))'))
layer.updateFeature(fid, Geometry.fromWkt('POINT (5 6)'))
feature.setGeometry(Geometry.fromWkt('POINT (7 8)'))
raster.rasterizeSync([Geometry.fromWkt(box), geojsonBox], { burnValues: [1, 2] })
```

### GEOS：谓词与集合运算

`Geometry` 也带上了 GDAL 通过 GEOS 实现的那些操作 —— 谓词（`intersects`、`contains`、
`within`、`crosses`、`touches`、`overlaps`、`disjoint`、`equals`）、`distance`、
`isValid` / `isSimple`，以及集合运算 `buffer`、`centroid`、`convexHull`、`simplify`、
`union`、`intersection`、`difference`、`symDifference`：

```js
if (gdal.features().geos) {
  const hits = plot.intersects(roads)
  const ring = plot.buffer(100, 16)     // 外扩 100 个单位，每象限 16 段
  const merged = plot.union(neighbour)  // 返回新的 Geometry
}
```

GEOS 由构建过程获取、编译并**静态链接**，和 GDAL、PROJ 一样，所以这些开箱即用，包依然是单个
自包含产物。`docs/GEOS.md` 记录了这个决定（以及为什么共享库在这里更糟），还有发布时欠下的
LGPL-2.1 §6 材料。

没有 GEOS 的构建接口形状一致：每个调用都会回 “this build has no GEOS”，而不是一个看起来像
答案的 `false`；`gdal.features().geos` 就是让你绕开那条路的探针。

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

`FieldDefinition` 还接受 `nullable`、`unique`、`defaultValue`（文本 —— GDAL 自己的表示，
所以整数默认值是字符串 `'0'`）和 `justification`（`'Undefined'` / `'Left'` / `'Right'`）。
`layer.fields` 会把它们全部报回来，因此一个定义可以完整往返：

```js
layer.fields
// [{ name: 'label', fieldType: 'String', width: 64, precision: 0,
//    nullable: true, unique: false, defaultValue: null, justification: 'Undefined' }]
```

### 修改已有 schema

`createLayer` 是**声明** schema；已经存在的图层也能改。所有调用都按**名字**而不是索引，
因为一次改动会让后面的位置整体位移：

```js
layer.addField({ name: 'area', fieldType: 'Real', defaultValue: '0' })
layer.deleteField('note')
layer.reorderFields(['area', 'label'])   // 必须把每个字段都写一遍，且只写一次
```

`addField` 收的是与 `createLayer` 相同的 `FieldDefinition`，所以一条字段无论声明而来还是
后加而来，自我描述都完全一致。并非所有驱动都支持：先问
`layer.testCapability('CreateField')`，不能做的驱动会直接说出来而不是做一半 —— GeoPackage
（底层是 SQLite）不会删掉 `UNIQUE` 索引依赖的列，并且会把这个原因原样带出来。

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

### SQL

`executeSql()` 走 GDAL 的 `GDALDatasetExecuteSQL`，把查询结果作为普通记录数组返回，
形状与 `featuresSync()` 一致：

```js
const rows = dataset.executeSql(
  'SELECT name, population FROM places WHERE population > 1000',
)
// [{ fid, properties: { name: 'beta', population: 4500 }, geometry: null }, …]
```

查询给的是记录而不是 `Layer`，这是有意的：结果集没有图层序号 —— 它可以连接多个图层、
给字段起别名或做聚合 —— 所以没有 `dataset.layer(i)` 与之对应。第二个参数指定 GDAL 的
SQL 方言，`'OGRSQL'` 或 `'SQLITE'`；不传则用驱动自己的默认方言。没有结果集的语句
（`ALTER TABLE`、`CREATE INDEX` 之类）返回 `[]`。

### 事务

`startTransaction()`、`commitTransaction()`、`rollbackTransaction()` 把多次写入并成一个单元
—— 对应 GDAL 的 `OGR_L_StartTransaction` 系列：

```js
layer.startTransaction()
try {
  layer.createFeature(point, { name: 'a' })
  layer.createFeature(point, { name: 'b' })
  layer.commitTransaction()
} catch (error) {
  layer.rollbackTransaction()
  throw error
}
```

并非所有驱动都支持：依赖分组之前先问 `layer.testCapability('Transactions')`。
不支持的驱动只会警告一句然后照常执行，等于事务没起作用。

GeoPackage 有一个坑：它的表是**首次写入**时才惰性建的，所以首次写入要放在事务**外面**。
放进事务里，`CREATE TABLE` 会跟着要素一起回滚，之后每次写入都会以 `no such table` 失败。

### Feature id、几何列与能力

```js
layer.fidColumn                           // 'fid'；由 GDAL 生成 id 时为 null
layer.geomColumn                          // 'geom'；图层没有几何时为 null
layer.testCapability('FastFeatureCount')  // true / false
layer.testCapability('Transactions')
```

`testCapability` 用 GDAL 自己的名字 —— `FastFeatureCount`、`FastGetExtent`、`RandomRead`、
`SequentialWrite`、`DeleteFeature`、`Transactions`、`CreateField`、`CreateGeomField` 等等。
GDAL 不认识的名字一律回答 `false` 而不是抛错：这是一次询问，而「没有」也是答案之一。

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
- **`gdalbuildvrt` 也提供了**，即 `buildVrt` / `buildVrtSync`：

  ```js
  gdal.buildVrtSync('merged.vrt', ['a.tif', 'b.tif'], ['-separate'])
  const inMemory = await gdal.buildVrt('', ['a.tif'])   // 目标为空则建在内存里
  ```

  一个源就是「把这个栅格包成 VRT、不复制像素」的用法，多个源则合并；`args` 是
  `gdalbuildvrt` 自己的参数（`-separate`、`-resolution`、`-te`）。返回的就是普通
  `Dataset`。有一点要知道：**`GDALBuildVRT` 会拒绝完全没有地理参考的输入**，全都
  被跳过时这次调用就失败。

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
两个 musl 目标标记为 `experimental`（`continue-on-error`）：它们在 **musl 原生的 Alpine
容器**（`docker/musl.Dockerfile`）里构建，而容器跑在与目标同架构的 runner 上，所以容器
自带的工具链本来就是 cargo 要的那个 musl 三元组 —— 没有交叉工具链、没有 sysroot、没有
模拟执行。它仍是矩阵里最不确定的一环，原因是全驱动集会拉进 HDF5、netCDF、curl、libpq
这些自带 C 库以及它们的 CMake/configure；这一步失败只会被报告，不会让整轮变红。测试也在
同一个镜像里跑，那里 musl 就是原生 libc。Intel macOS 未构建。

那两条 musl 腿的测试跑在同一个容器里，而不是 runner 上：napi 会把 musl
**动态**链接（加 `-C target-feature=-crt-static`），runner 上的 glibc Node 根本无法加载
这样的 addon（一个进程里两个 libc）。容器也是更诚实的验证场所 —— 那里生成的 loader 会
解析到 musl，跑的就是真产物，而不是披着 musl 标签的宿主构建。

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
| GEOS | 由 `geos-src` 获取并编译，**静态链接**（LGPL-2.1，见文末许可证一节） |

因为 `gdal-src` 不点名就关闭所有驱动，Cargo 的 `bundled` feature 列表**就是**发布的驱动集合 ——
现在它写的是 `gdal-src/all_drivers`，也就是那个 crate 能构建的全部。

共注册 **148 个驱动**，`drivers()` 是权威列表。在支撑 GTiff/COG 的内部
libtiff / libgeotiff / libjpeg / libpng 之外，还包括：HDF5 与 netCDF（连同它们所需的 HDF5，
全部静态链接）、curl 系的网络驱动（WMS、WMTS、WCS、OGCAPI、PLMOSAIC、Carto、Elasticsearch、
NGW、AmigoCloud）、PostgreSQL 与 PostGIS、GRIB、STACIT/STACTA、FlatGeobuf、
GeoJSON / GeoJSONSeq / TopoJSON / ESRIJSON、GPKG、SQLite、OpenFileGDB、ESRI Shapefile、
MapInfo、DXF、DGN、CAD、S57、VDV、VFK、CSV、GTFS、Selafin、KMLSUPEROVERLAY、PGDUMP，
以及一长串各国测绘与科学数据格式。

**GEOS** 也链进去了 —— 和其余一样由构建过程获取、编译、静态链接 —— `Geometry.intersects`、
`buffer`、`simplify` 与集合运算正是靠它。

**故意不含**的：

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

CRS 变换覆盖点、坐标数组、包围盒和整个几何对象（`transformGeometry`），但不暴露
`CoordTransformOptions`（指定转换管线、精度目标），且变换是同步的 —— 上百万个点需要调用方自行分块。

读图层可以按批读（游标），但那是游标而不是 JS 的 async iterator；且 GDAL 的读取位置在图层上，
同一图层同时只能有一个读取者。

波段的元数据与直方图现在可读可写（`setScale` / `setOffset` / `setUnitType` / `setDescription` /
`setCategoryNames`，以及 `defaultHistogram` / `setDefaultHistogram`），与 `setStatistics()` 对齐。
唯一的不对称是 `scale` 与 `offset` 没有“清除”：GDAL 的 setter 只收数字，所以 `0` 就是一个普通
取值。

Intel macOS 与 32 位目标未构建。

## 从 `gdal-async` 迁移

主入口**不是**直接替代品 —— 它是 0-based、阻塞形式叫 `xxxSync()`、赋值靠 `setX()`。
另一个入口是：

```js
const gdal = require('gdal-rs-napi/compat')
```

它是同一份绑定之上的 JS 适配器，而不是第二套实现 —— 没有重新实现任何东西，也没有少任何东西：

```js
const dataset = gdal.open('dem.tif')
const band = dataset.bands.get(1)          // 1-based，与 gdal-async 一致
band.pixels.read(0, 0, 4, 4)               // 波段自身类型的 TypedArray
band.noDataValue = -9999                   // 赋值，而不是 setNoDataValue()
dataset.srs = new gdal.SpatialReference(wkt)

for (const feature of layer.features) {    // 可迭代，和集合一样
  feature.fields.toObject()                // { … }
  feature.geometry instanceof gdal.Point   // 类族，`instanceof` 成立
}
```

`feature.fields.set('population', 11)` 直接写穿；`feature.geometry =
gdal.fromWKT('POINT (9 9)')` 直接替换。阻塞/异步成对为 `xxx()` / `xxxAsync()`，
`xxxAsync` 也接受 node 风格回调。

**不覆盖**的部分（免得迁移时才发现）：Streams、多维数组、`calcAsync` 和 VRT 像素函数。
原生 API 能做的其余一切，适配层都能做 —— 包括 GEOS 谓词，因为它们在同一个构建里。
完整清单见 `PHASE1.md`（WS-7）。

## 许可证

MIT。GDAL 与 PROJ 均为 MIT/X11；详见 [LICENSE](./LICENSE)，以及 [THIRD-PARTY.md](./THIRD-PARTY.md)
（打出包里的全部第三方组件及各自许可证）。

其中 GEOS 是例外：它是 LGPL-2.1，且被**静态链接**进发布出去的 `.node`。LGPL-2.1 §6 要求静态
链接作品的发布者提供「把它与修改过的 GEOS 重新链接」的手段，因此每次发布都会在平台 tarball
旁附上 `…-lgpl-geos.tar.gz` —— 构建所用的 GEOS 源码、静态库，以及一份重新链接说明
（`npm run lgpl` 生成）。这约束的是**发布物**，不是本仓库代码的许可证 —— 见 `docs/GEOS.md`。
