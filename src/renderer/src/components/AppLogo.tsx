import type { ReactElement } from 'react'
import { motion } from 'framer-motion'
// 前端 Logo 使用构建生成的透明派生资源；assets/icon 下的原图始终只读。
import iconUrl from '../../../../build/icon-256.png'

// 修复点 1.18: JSX.Element 来自 @types/react，jsx runtime 模式下文件里依然要显式 import 对应类型。
// 用 ReactElement 是 React 官方推荐的 JSX.Element 替代品。
function AppLogo(): ReactElement {
  return (
    <div className="flex items-center gap-2 select-none">
      {/* 统一液态玻璃风格图标 - 与窗口/任务栏/托盘/安装包同源 */}
      <motion.img
        src={iconUrl}
        alt="mplay"
        className="w-7 h-7 object-contain bg-transparent"
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        draggable={false}
        style={{
          background: 'transparent',
          boxShadow: '0 2px 10px rgba(0,122,255,0.28)',
        }}
      />

      {/* 文字 */}
      <span
        className="font-bold text-[14px] tracking-tight"
        style={{
          background: 'linear-gradient(180deg, rgba(0,122,255,1) 0%, rgba(60,150,240,0.85) 100%)',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          backgroundClip: 'text',
        }}
      >
        mplay
      </span>
    </div>
  )
}

export default AppLogo
