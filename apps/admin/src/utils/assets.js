// 把 public 下的相对资源路径补上 Vite base，兼容子路径部署（与游戏站同款）。
export function publicAssetUrl(path) {
  if (
    path
    && !/^(?:[a-z]+:)?\/\//i.test(path)
    && !path.startsWith('data:')
    && !path.startsWith('blob:')
  ) {
    return `${import.meta.env.BASE_URL}${path.replace(/^\/+/, '')}`
  }

  return path
}
