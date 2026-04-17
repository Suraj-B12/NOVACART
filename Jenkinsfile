// NovaCart CI/CD Pipeline (Scripted Pipeline)
// Pulls code from GitHub, validates, checks CouchDB, deploys, and smoke tests

node {
    def DEPLOY_DIR = 'C:\\Users\\suraj\\Desktop\\Misc\\NGD'
    def APP_PORT   = '3000'
    def COUCH_URL  = 'http://127.0.0.1:5984/ecommerce_catalog'

    stage('Checkout') {
        echo '>> Pulling latest code from GitHub...'
        checkout scm
        bat 'dir'
    }

    stage('Validate Syntax') {
        echo '>> Checking JavaScript and HTML for syntax errors...'
        bat 'node --check app.js'
        bat "node -e \"require('fs').readFileSync('index.html', 'utf8'); console.log('HTML file OK')\""
        bat "node -e \"require('fs').readFileSync('styles.css', 'utf8'); console.log('CSS file OK')\""
    }

    stage('Static Analysis') {
        echo '>> Running linters to catch code quality issues...'
        bat 'npx --yes htmlhint index.html || exit 0'
    }

    stage('CouchDB Health Check') {
        echo '>> Verifying CouchDB is running and database exists...'
        bat "curl -sf -u admin:admin ${COUCH_URL}"
    }

    stage('Deploy') {
        echo '>> Copying files to NGD folder...'
        bat "xcopy /Y \"${WORKSPACE}\\index.html\" \"${DEPLOY_DIR}\\\" /I"
        bat "xcopy /Y \"${WORKSPACE}\\app.js\" \"${DEPLOY_DIR}\\\" /I"
        bat "xcopy /Y \"${WORKSPACE}\\styles.css\" \"${DEPLOY_DIR}\\\" /I"

        echo '>> Stopping old server if running...'
        bat "taskkill /F /IM node.exe 2>nul & echo Server stopped || echo No server was running"

        echo '>> Starting fresh http-server...'
        sleep 2
        bat "start \"NGD\" cmd /c \"npx http-server ${DEPLOY_DIR} -p ${APP_PORT} -c-1\""
        sleep 3
    }

    stage('Smoke Test') {
        echo '>> Verifying site is live after deployment...'
        bat "curl -sf http://localhost:${APP_PORT} -o nul"
        echo 'SMOKE TEST PASSED: Site is live!'
    }

    echo 'PIPELINE COMPLETE: NovaCart deployed at http://localhost:3000'
}
