@echo off
cd /d D:\dsh_workspace\dsh-503-guard
echo ==================================================
echo  发布 dsh-503-guard 1.0.0 到 npm
echo  1) 按回车后 npm 会打印授权链接
echo  2) 浏览器里点 Authorize，再用验证器 / Windows Hello 确认
echo  3) 回到本窗口看是否出现 npm notice Publishing
echo ==================================================
pause
call npm publish
echo.
echo [done] 若要二次确认：npm publish --otp=123456
echo [done] 若提示 staged：npm stage approve <id>
echo.
pause
