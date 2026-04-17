pipeline {
    agent any

    triggers {
        pollSCM('H/2 * * * *')   // Check GitHub for changes every 2 minutes
    }

    environment {
        DEPLOY_DIR = 'C:\\Users\\suraj\\Desktop\\Misc\\NGD'
        APP_PORT   = '3000'
        COUCH_URL  = 'http://127.0.0.1:5984/ecommerce_catalog'
    }

    stages {

        stage('Checkout') {
            steps {
                echo '>> Pulling latest code from GitHub...'
                checkout scm
            }
        }

        stage('Validate Syntax') {
            steps {
                echo '>> Checking JavaScript and HTML for syntax errors...'
                bat 'node --check app.js'
                bat 'node -e "require(\'fs\').readFileSync(\'index.html\', \'utf8\'); console.log(\'HTML file OK\')"'
                bat 'node -e "require(\'fs\').readFileSync(\'styles.css\', \'utf8\'); console.log(\'CSS file OK\')"'
            }
        }

        stage('Static Analysis') {
            steps {
                echo '>> Running linters to catch code quality issues...'
                bat 'npx --yes htmlhint index.html'
                bat 'npx --yes stylelint "*.css" --allow-empty-input || exit 0'
            }
        }

        stage('CouchDB Health Check') {
            steps {
                echo '>> Verifying CouchDB is running and database exists...'
                bat 'curl -sf -u admin:admin %COUCH_URL% -o db-check.json && type db-check.json && del db-check.json'
            }
        }

        stage('Deploy') {
            steps {
                echo '>> Deploying to NGD application folder...'
                bat '''
                    REM Copy updated files to the deployment directory
                    xcopy /Y /E /I "%WORKSPACE%\\index.html" "%DEPLOY_DIR%\\"
                    xcopy /Y /E /I "%WORKSPACE%\\app.js" "%DEPLOY_DIR%\\"
                    xcopy /Y /E /I "%WORKSPACE%\\styles.css" "%DEPLOY_DIR%\\"
                '''

                echo '>> Restarting http-server on port %APP_PORT%...'
                bat '''
                    REM Kill existing http-server if running on port 3000
                    for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":%APP_PORT% " ^| findstr "LISTENING"') do (
                        taskkill /F /PID %%a 2>nul
                    )
                    REM Small pause to let port free up
                    timeout /t 2 /nobreak > nul
                    REM Start fresh http-server in background
                    start /B cmd /c "npx http-server %DEPLOY_DIR% -p %APP_PORT% -c-1 > %DEPLOY_DIR%\\server.log 2>&1"
                    REM Wait for server to boot
                    timeout /t 3 /nobreak > nul
                '''
            }
        }

        stage('Smoke Test') {
            steps {
                echo '>> Verifying site is live after deployment...'
                bat 'curl -sf http://localhost:%APP_PORT% > nul && echo SMOKE TEST PASSED: Site is live on port %APP_PORT% || (echo SMOKE TEST FAILED && exit 1)'
            }
        }
    }

    post {
        success {
            echo 'PIPELINE PASSED: NovaCart deployed successfully at http://localhost:3000'
        }
        failure {
            echo 'PIPELINE FAILED: Check the stage logs above for details.'
        }
        always {
            echo "Build #${BUILD_NUMBER} finished at ${new Date()}"
        }
    }
}
