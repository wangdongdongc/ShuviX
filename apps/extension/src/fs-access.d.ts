// File System Access API —— 默认 lib.dom 未声明 Window.showDirectoryPicker，这里补充。
// FileSystemDirectoryHandle 等句柄类型 lib.dom 已有，仅补入口方法 + 目录迭代 + 权限 API。
interface DirectoryPickerOptions {
  id?: string
  mode?: 'read' | 'readwrite'
  startIn?: FileSystemHandle | string
}

interface Window {
  showDirectoryPicker(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>
}

interface FileSystemHandlePermissionDescriptor {
  mode?: 'read' | 'readwrite'
}

// 权限 API（lib.dom 未声明）：句柄持久化后跨会话需重新授权
interface FileSystemHandle {
  queryPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>
  requestPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>
}

// 目录异步迭代（lib.dom 在部分 TS 版本未声明 entries/keys/values）
interface FileSystemDirectoryHandle {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>
  keys(): AsyncIterableIterator<string>
  values(): AsyncIterableIterator<FileSystemHandle>
}
