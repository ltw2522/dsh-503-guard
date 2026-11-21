@echo off
cd /d D:\dsh_workspace\dsh-503-guard
echo ==================================================
echo  dsh-503-guard 1.0.0 - npm 发布（两步）
echo ==================================================
echo.
echo [1/2] 登录 npm：下面会打开浏览器，点 Authorize 后自动回跳
echo       如果已经登录成功可以按 Ctrl+C 跳过这一步
echo.
call npm login --auth-type=web
echo.
echo [2/2] 发布
call npm publish
echo.
echo [done] 若提示需要一次性验证码：npm publish --otp=123456
echo [done] 若提示 staged：npm stage approve ^<id^>
echo.
pause
