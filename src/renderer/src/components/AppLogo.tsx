import type { ReactElement } from 'react'
import { motion } from 'framer-motion'
import iconUrl from '../../../../build/icon-256.png'

function AppLogo(): ReactElement {
  return (
    <div className="flex items-center gap-2 select-none">
      <motion.div
        className="relative"
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
      >
        <motion.img
          src={iconUrl}
          alt="环影"
          className="w-7 h-7 sm:w-8 sm:h-8 object-contain"
          draggable={false}
          whileHover={{
            scale: 1.15,
            rotate: 5,
          }}
          whileTap={{
            scale: 0.95,
            rotate: -2,
          }}
          transition={{
            type: 'spring',
            stiffness: 400,
            damping: 17,
          }}
        />

        <motion.div
          className="absolute inset-0 rounded-full pointer-events-none"
          initial={{ opacity: 0 }}
          whileHover={{
            opacity: [0, 0.4, 0],
            scale: [1, 1.4, 1.6],
          }}
          transition={{
            duration: 1,
            repeat: Infinity,
            repeatDelay: 0.5,
          }}
          style={{
            background: 'radial-gradient(circle, rgba(0,122,255,0.3) 0%, transparent 70%)',
          }}
        />
      </motion.div>

      <motion.span
        className="font-bold text-[14px] sm:text-[15px] tracking-tight"
        initial={{ opacity: 0, x: -10 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.5, delay: 0.2, ease: 'easeOut' }}
        whileHover={{
          scale: 1.02,
        }}
        style={{
          background: 'linear-gradient(180deg, rgba(0,122,255,1) 0%, rgba(60,150,240,0.85) 100%)',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          backgroundClip: 'text',
        }}
      >
        环影
      </motion.span>
    </div>
  )
}

export default AppLogo
