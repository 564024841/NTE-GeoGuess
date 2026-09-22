// 截图路径 → 当前可用 URL 的运行期映射。
//
// 场景：后台部署在静态托管、没有写入接口时，新增的截图无法直接访问，
// 只有会话内的 blob URL 可用。为了保证：
//   · 题目数据里始终是真实路径 /images/questions/<id>.<ext>（能落库、能导出）
//   · 本次会话里又能看到截图
// 这里放一层中立映射：写入端（后台）登记，读取端（<img> 解析）查表。

const urlsByPath = new Map()

export function registerImageUrl(path, url) {
  if (path && url) urlsByPath.set(path, url)
}

export function resolveRegisteredImage(path) {
  if (!path) return null
  return urlsByPath.get(path) || null
}

export function clearRegisteredImageUrls() {
  for (const url of urlsByPath.values()) {
    try {
      URL.revokeObjectURL(url)
    } catch {
      /* 忽略 */
    }
  }
  urlsByPath.clear()
}
