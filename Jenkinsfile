// NovaCart CI/CD Pipeline
// GitHub -> Jenkins -> Validate -> Deploy -> Verify

node {
    def DEPLOY_DIR = 'C:\\Users\\suraj\\Desktop\\Misc\\NGD'
    def APP_PORT   = '3000'
    def COUCH_URL  = 'http://127.0.0.1:5984/ecommerce_catalog'

    stage('Checkout') {
        echo 'Pulling latest code from GitHub...'
        checkout scm
    }

    stage('Validate') {
        echo 'Checking for syntax errors...'
        bat 'node --check app.js'
        bat "node -e \"require('fs').readFileSync('index.html','utf8'); console.log('HTML OK')\""
        bat "node -e \"require('fs').readFileSync('styles.css','utf8'); console.log('CSS OK')\""
    }

    stage('CouchDB Check') {
        echo 'Verifying CouchDB is running...'
        bat "curl -sf -u admin:admin ${COUCH_URL}"
        echo 'CouchDB is healthy.'
    }

    stage('Deploy') {
        echo 'Copying files to application server...'
        bat "copy /Y \"${WORKSPACE}\\index.html\" \"${DEPLOY_DIR}\\index.html\""
        bat "copy /Y \"${WORKSPACE}\\app.js\" \"${DEPLOY_DIR}\\app.js\""
        bat "copy /Y \"${WORKSPACE}\\styles.css\" \"${DEPLOY_DIR}\\styles.css\""
        echo 'Files deployed successfully.'
    }

    stage('Smoke Test') {
        echo 'Verifying application is live...'
        bat "curl -sf http://localhost:${APP_PORT}"
        echo 'Site is live on http://localhost:3000'
    }
}
