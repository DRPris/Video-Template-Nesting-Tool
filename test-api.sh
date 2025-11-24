#!/bin/bash

###############################################################################
# API 测试脚本
# 用于验证视频处理系统的所有端点是否正常工作
###############################################################################

BASE_URL="http://localhost:3000"
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "======================================"
echo "视频处理系统 API 测试"
echo "======================================"
echo ""

# 测试 1: 主页面
echo -n "测试 1: 主页面 (GET /)... "
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/")
if [ "$STATUS" -eq 200 ]; then
    echo -e "${GREEN}✓ 通过${NC} (HTTP $STATUS)"
else
    echo -e "${RED}✗ 失败${NC} (HTTP $STATUS)"
fi

# 测试 2: API 处理端点（无文件上传）
echo -n "测试 2: 视频处理端点 (POST /api/process) [无文件]... "
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/process")
if [ "$STATUS" -eq 400 ] || [ "$STATUS" -eq 500 ]; then
    echo -e "${GREEN}✓ 通过${NC} (HTTP $STATUS - 预期错误响应)"
else
    echo -e "${YELLOW}⚠ 警告${NC} (HTTP $STATUS - 非预期响应)"
fi

# 测试 3: 输出端点（不存在的文件）
echo -n "测试 3: 视频输出端点 (GET /api/output/test.mp4) [不存在的文件]... "
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/api/output/test.mp4")
if [ "$STATUS" -eq 404 ]; then
    echo -e "${GREEN}✓ 通过${NC} (HTTP $STATUS - 预期 404)"
else
    echo -e "${YELLOW}⚠ 警告${NC} (HTTP $STATUS)"
fi

# 测试 4: 检查服务器健康
echo -n "测试 4: 服务器健康检查... "
RESPONSE=$(curl -s -w "\n%{http_code}" "$BASE_URL/")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
if [ "$HTTP_CODE" -eq 200 ]; then
    echo -e "${GREEN}✓ 服务器运行正常${NC}"
else
    echo -e "${RED}✗ 服务器异常${NC}"
fi

echo ""
echo "======================================"
echo "API 端点列表"
echo "======================================"
echo "1. GET  $BASE_URL/"
echo "2. POST $BASE_URL/api/process"
echo "3. GET  $BASE_URL/api/output/[filename]"
echo ""
echo "======================================"
echo "测试完成"
echo "======================================"
echo ""
echo -e "${YELLOW}注意:${NC} 完整的文件上传测试需要实际的视频文件"
echo "请使用网页界面或 cURL 进行完整测试"
echo ""

