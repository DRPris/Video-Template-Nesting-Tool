/**
 * 系统环境测试脚本
 * 
 * 用于检测视频处理系统的依赖项是否正确安装
 * 
 * 使用方法:
 * node test-system.js
 */

console.log('🔍 开始检测系统环境...\n');

// 测试 1: Node.js 版本
console.log('📦 Node.js 版本检测');
console.log('   版本:', process.version);
console.log('   平台:', process.platform);
console.log('   架构:', process.arch);

const nodeVersion = parseInt(process.version.slice(1).split('.')[0]);
if (nodeVersion >= 18) {
  console.log('   ✅ Node.js 版本符合要求 (>= 18)\n');
} else {
  console.log('   ❌ Node.js 版本过低,需要 >= 18\n');
}

// 测试 2: 检查必需的 npm 包
console.log('📚 检测必需的 npm 包');

const requiredPackages = [
  'fluent-ffmpeg',
  'ffmpeg-static',
  'formidable',
];

let allPackagesInstalled = true;

for (const pkg of requiredPackages) {
  try {
    require.resolve(pkg);
    console.log(`   ✅ ${pkg} 已安装`);
  } catch (e) {
    console.log(`   ❌ ${pkg} 未安装`);
    allPackagesInstalled = false;
  }
}

if (!allPackagesInstalled) {
  console.log('\n   请运行以下命令安装缺失的包:');
  console.log('   pnpm install\n');
}

console.log('');

// 测试 3: FFmpeg 可用性
console.log('🎬 检测 FFmpeg');

try {
  const ffmpeg = require('fluent-ffmpeg');
  const ffmpegStatic = require('ffmpeg-static');
  
  if (ffmpegStatic) {
    ffmpeg.setFfmpegPath(ffmpegStatic);
    console.log('   ✅ ffmpeg-static 已找到');
    console.log('   路径:', ffmpegStatic);
    
    // 测试 FFmpeg 是否能正常工作
    ffmpeg.getAvailableFormats((err, formats) => {
      if (err) {
        console.log('   ❌ FFmpeg 无法正常工作');
        console.log('   错误:', err.message);
      } else {
        console.log('   ✅ FFmpeg 工作正常');
        console.log('   支持的格式数量:', Object.keys(formats).length);
        console.log('   部分支持的格式:', Object.keys(formats).slice(0, 10).join(', '));
        
        // 显示总结
        displaySummary();
      }
    });
  } else {
    console.log('   ❌ ffmpeg-static 未找到');
    console.log('   请运行: pnpm install ffmpeg-static\n');
  }
} catch (e) {
  console.log('   ❌ 无法加载 FFmpeg 相关包');
  console.log('   错误:', e.message);
  console.log('   请运行: pnpm install fluent-ffmpeg ffmpeg-static\n');
}

// 测试 4: 检查 /tmp 目录
console.log('\n📁 检测临时文件目录');

const fs = require('fs');
const path = require('path');

const tmpDir = process.platform === 'win32' ? process.env.TEMP : '/tmp';
console.log('   临时目录路径:', tmpDir);

try {
  // 尝试写入测试文件
  const testFile = path.join(tmpDir, `test_${Date.now()}.txt`);
  fs.writeFileSync(testFile, 'test');
  fs.unlinkSync(testFile);
  console.log('   ✅ 临时目录可写\n');
} catch (e) {
  console.log('   ❌ 临时目录不可写');
  console.log('   错误:', e.message, '\n');
}

// 显示总结
function displaySummary() {
  console.log('\n' + '='.repeat(50));
  console.log('📊 检测总结');
  console.log('='.repeat(50));
  
  if (nodeVersion >= 18 && allPackagesInstalled) {
    console.log('✅ 系统环境配置正常');
    console.log('\n建议操作:');
    console.log('1. 确保 Next.js 开发服务器正在运行 (pnpm dev)');
    console.log('2. 打开浏览器访问 http://localhost:3000');
    console.log('3. 打开浏览器开发者工具 (F12)');
    console.log('4. 上传视频和模板,点击"开始生成视频"');
    console.log('5. 查看浏览器控制台和服务器终端的日志');
    console.log('\n如果仍有问题,请查看 DEBUG_GUIDE.md 文档');
  } else {
    console.log('❌ 系统环境存在问题');
    console.log('\n请解决上述标记为 ❌ 的问题后重新测试');
    console.log('运行: node test-system.js');
  }
  
  console.log('='.repeat(50) + '\n');
}

