import { rm, rename } from 'fs/promises';
import { existsSync } from 'fs';

async function removeDirWithRetry(path, maxRetries = 3, delay = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      if (existsSync(path)) {
        await rm(path, { recursive: true, force: true });
        console.log(`✅ 成功删除目录: ${path}`);
        return true;
      }
      return true;
    } catch (err) {
      console.warn(`⚠️ 删除目录失败 (尝试 ${i + 1}/${maxRetries}): ${path}`);
      console.warn(`   错误: ${err.message}`);
      if (i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, delay * (i + 1)));
      }
    }
  }
  return false;
}

async function quarantineDir(path) {
  if (!existsSync(path)) return;
  
  const quarantinePath = `${path}.quarantine.${Date.now()}`;
  try {
    await rename(path, quarantinePath);
    console.log(`✅ 已将目录隔离到: ${quarantinePath}`);
    return true;
  } catch (err) {
    console.warn(`⚠️ 隔离目录失败: ${path}`);
    console.warn(`   错误: ${err.message}`);
    return false;
  }
}

async function main() {
  console.log('=== 清理构建目录 ===');
  
  const dirsToClean = [
    '.generated.old',
    '.generated',
    'dist',
    'dist3',
    'out',
  ];
  
  for (const dir of dirsToClean) {
    const path = `./${dir}`;
    if (!existsSync(path)) continue;
    
    console.log(`处理目录: ${path}`);
    
    const removed = await removeDirWithRetry(path);
    if (!removed) {
      console.log(`尝试隔离目录: ${path}`);
      await quarantineDir(path);
    }
  }
  
  console.log('=== 清理完成 ===');
}

main().catch(err => {
  console.error('清理脚本出错:', err);
  process.exit(1);
});