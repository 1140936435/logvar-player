import { motion } from 'framer-motion'

function AppLogo(): JSX.Element {
  return (
    <div className="flex items-center gap-2 select-none">
      {/* 玻璃质感播放按钮 */}
      <motion.div
        className="relative w-7 h-7 rounded-lg flex items-center justify-center"
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        style={{
          background: 'linear-gradient(135deg, rgba(0,122,255,0.85) 0%, rgba(90,180,255,0.70) 40%, rgba(100,200,255,0.55) 100%)',
          boxShadow: '0 2px 10px rgba(0,122,255,0.28), 0 0 1px rgba(255,255,255,0.25), inset 0 1px 0 rgba(255,255,255,0.30), inset 0 -1px 3px rgba(0,0,0,0.08)',
          border: '0.5px solid rgba(255,255,255,0.22)',
        }}
      >
        {/* 高光反射 */}
        <div
          className="absolute inset-0 rounded-lg overflow-hidden pointer-events-none"
          style={{
            background: 'linear-gradient(180deg, rgba(255,255,255,0.20) 0%, transparent 50%, rgba(0,0,0,0.04) 100%)',
          }}
        />
        <svg width="13" height="13" viewBox="0 0 24 24" fill="white" className="ml-0.5 drop-shadow-[0_1px_1px_rgba(0,0,0,0.15)] relative z-10">
          <polygon points="6,3 20,12 6,21" />
        </svg>
      </motion.div>

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
