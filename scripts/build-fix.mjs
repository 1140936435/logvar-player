import { rm, mkdir, rename, readdir, copyFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { exec } from 'child_process';

async function removeDir(path) {
  if (!existsSync(path)) return;
  try {
    await rm(path, { recursive: true, force: true });
    console.log(`✅ 删除目录: ${path}`);
  } catch (err) {
    console.warn(`⚠️ 删除失败: ${path} - ${err.message}`);
  }
}

async function quarantineDir(path) {
  if (!existsSync(path)) return;
  const quarantinePath = `${path}.quarantine.${Date.now()}`;
  try {
    await rename(path, quarantinePath);
    console.log(`✅ 隔离目录: ${path} -> ${quarantinePath}`);
    return true;
  } catch (err) {
    console.warn(`⚠️ 隔离失败: ${path} - ${err.message}`);
    return false;
  }
}

function execCommand(command, cwd) {
  return new Promise((resolve, reject) => {
    const child = exec(command, { cwd, maxBuffer: 1024 * 1024 * 10 });
    child.stdout.on('data', data => process.stdout.write(data));
    child.stderr.on('data', data => process.stderr.write(data));
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`命令失败，退出码: ${code}`));
    });
  });
}

async function main() {
  console.log('=== 开始打包 (带修复方案) ===\n');
  
  const cwd = process.cwd();
  
  console.log('1. 清理旧文件...');
  await removeDir('dist');
  await removeDir('dist3');
  await removeDir('out');
  
  console.log('\n2. 处理 .generated 目录...');
  if (existsSync('.generated')) {
    const quarantined = await quarantineDir('.generated');
    if (!quarantined) {
      await removeDir('.generated');
    }
  }
  if (existsSync('.generated.old')) {
    const quarantined = await quarantineDir('.generated.old');
    if (!quarantined) {
      await removeDir('.generated.old');
    }
  }
  
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  console.log('\n3. 创建手动图标目录...');
  await mkdir('.generated/icons', { recursive: true });
  
  const buildIcons = [
    'icon.ico', 'icon.png', 'icon-16.png', 'icon-24.png',
    'icon-32.png', 'icon-48.png', 'icon-64.png', 'icon-128.png',
    'icon-256.png', 'icon-512.png'
  ];
  
  for (const icon of buildIcons) {
    const src = `build/${icon}`;
    const dest = `.generated/icons/${icon}`;
    if (existsSync(src)) {
      try {
        await copyFile(src, dest);
        console.log(`   ✅ 复制: ${icon}`);
      } catch (err) {
        console.warn(`   ⚠️ 复制失败: ${icon} - ${err.message}`);
      }
    }
  }
  
  console.log('\n4. 执行构建...');
  await execCommand('npm run build', cwd);
  
  console.log('\n5. 执行 Electron Builder...');
  try {
    await execCommand('npx electron-builder --win --dir --config', cwd);
    console.log('\n✅ 打包成功!');
  } catch (err) {
    console.error('\n❌ 打包失败:', err.message);
    
    if (err.message.includes('EPERM') && err.message.includes('.generated.old')) {
      console.log('\n🔄 检测到 .generated.old 问题，尝试修复...');
      await quarantineDir('.generated.old');
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      console.log('\n🔄 重新执行 Electron Builder...');
      try {
        await execCommand('npx electron-builder --win --dir --config', cwd);
        console.log('\n✅ 打包成功!');
      } catch (retryErr) {
        console.error('\n❌ 重试失败:', retryErr.message);
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