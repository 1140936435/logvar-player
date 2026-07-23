import { rm, mkdir, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { exec } from 'child_process';

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

async function ensureDir(path) {
  if (!existsSync(path)) {
    await mkdir(path, { recursive: true });
  }
}

function execCommand(command, cwd) {
  return new Promise((resolve, reject) => {
    console.log(`执行命令: ${command}`);
    const child = exec(command, { cwd, maxBuffer: 1024 * 1024 * 10 });
    
    child.stdout.on('data', data => {
      process.stdout.write(data);
    });
    
    child.stderr.on('data', data => {
      process.stderr.write(data);
    });
    
    child.on('close', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`命令失败，退出码: ${code}`));
      }
    });
  });
}

async function main() {
  console.log('=== 开始 Windows 打包 ===\n');
  
  const cwd = process.cwd();
  
  try {
    console.log('1. 清理旧构建文件...');
    await removeDirWithRetry('.generated.old');
    await removeDirWithRetry('.generated');
    await removeDirWithRetry('dist');
    await removeDirWithRetry('dist3');
    await removeDirWithRetry('out');
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    console.log('\n2. 执行构建...');
    await execCommand('npm run build', cwd);
    
    console.log('\n3. 执行 Electron Builder...');
    await execCommand('npx electron-builder --win --dir --config', cwd);
    
    console.log('\n✅ 打包成功!');
    
  } catch (err) {
    console.error('\n❌ 打包失败:', err.message);
    
    if (err.message.includes('EPERM') && err.message.includes('.generated.old')) {
      console.log('\n🔄 检测到 .generated.old 权限问题，尝试修复...');
      try {
        await removeDirWithRetry('.generated.old', 5, 2000);
        console.log('✅ .generated.old 目录已清理');
        console.log('\n🔄 重新执行打包...');
        await execCommand('npx electron-builder --win --dir --config', cwd);
        console.log('\n✅ 打包成功!');
      } catch (retryErr) {
        console.error('\n❌ 重试打包失败:', retryErr.message);
        process.exit(1);
      }
    } else {
      process.exit(1);
    }
  }
}

main().catch(err => {
  console.error('脚本出错:', err);
  process.exit(1);
});