@echo off
title IndhanShodhak TEST Server
color 0A
echo.
echo  ==========================================
echo   IndhanShodhak TEST Server Starting...
echo  ==========================================
echo.
echo   User App    : http://localhost:3000/
echo   Pump Owner  : http://localhost:3000/pump-owner
echo   Verifier    : http://localhost:3000/verify
echo   Govt View   : http://localhost:3000/govt
echo   Admin Panel : http://localhost:3000/admin
echo.
echo   Admin Login : 9999999999 / admin@123
echo.
echo  ==========================================
echo.
node server.js
pause
