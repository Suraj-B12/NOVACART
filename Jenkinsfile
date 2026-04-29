// NovaCart CI/CD Pipeline
// GitHub -> Jenkins polls every 1 min -> Validate -> Deploy -> Verify

// Poll GitHub once per minute. The deploy.bat helper also force-triggers builds,
// so a missed poll cycle never delays a deploy beyond 60 seconds.
properties([
    pipelineTriggers([pollSCM('H/1 * * * *')])
])

node {
    def DEPLOY_DIR = 'C:\\Users\\suraj\\Desktop\\Misc\\NGD'
    def APP_PORT   = '3000'
    def COUCH_URL  = 'http://127.0.0.1:5984/ecommerce_catalog'

    stage('Checkout') {
        echo 'Pulling latest code from GitHub...'
        checkout scm
        echo 'Checkout complete.'
    }

    stage('Validate') {
        echo 'Checking JS syntax...'
        bat 'node --check app.js'
        echo 'JS syntax OK.'
    }

    stage('CouchDB Check') {
        echo 'Pinging CouchDB...'
        bat "curl -sf -o nul -u admin:admin ${COUCH_URL}"
        echo 'CouchDB is reachable.'
    }

    stage('Deploy') {
        echo 'Copying files to NGD application server...'
        bat "copy /Y \"${WORKSPACE}\\index.html\" \"${DEPLOY_DIR}\\index.html\" > nul"
        bat "copy /Y \"${WORKSPACE}\\app.js\"      \"${DEPLOY_DIR}\\app.js\"      > nul"
        bat "copy /Y \"${WORKSPACE}\\styles.css\"  \"${DEPLOY_DIR}\\styles.css\"  > nul"
        echo '3 files deployed.'
    }

    stage('Smoke Test') {
        echo 'Verifying site is live...'
        bat "curl -sf -o nul http://localhost:${APP_PORT}"
        echo "Site is live on http://localhost:${APP_PORT}"
    }

    echo 'PIPELINE PASSED - NovaCart deployed.'
}
