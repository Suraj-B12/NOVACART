// NovaCart CI/CD Pipeline
// GitHub -> Poll every 1 min -> Validate -> Deploy -> Verify
// Each stage does ONE thing. Console output kept short.

pipeline {
    agent any

    triggers {
        pollSCM('* * * * *')   // Check GitHub every 1 minute
    }

    options {
        timestamps()
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '10'))
    }

    environment {
        DEPLOY_DIR = 'C:\\Users\\suraj\\Desktop\\Misc\\NGD'
        APP_PORT   = '3000'
        COUCH_URL  = 'http://127.0.0.1:5984/ecommerce_catalog'
    }

    stages {

        stage('Checkout') {
            steps {
                echo 'Pulling latest code from GitHub...'
                checkout scm
                echo 'Checkout complete.'
            }
        }

        stage('Validate') {
            steps {
                echo 'Checking JS syntax...'
                bat(script: 'node --check app.js', returnStatus: false)
                echo 'JS syntax OK.'
            }
        }

        stage('CouchDB Check') {
            steps {
                echo 'Pinging CouchDB...'
                bat(script: "curl -sf -o nul -u admin:admin ${COUCH_URL}", returnStatus: false)
                echo 'CouchDB is reachable.'
            }
        }

        stage('Deploy') {
            steps {
                echo 'Copying files to NGD application server...'
                bat(script: "copy /Y \"${WORKSPACE}\\index.html\" \"${DEPLOY_DIR}\\index.html\" > nul", returnStatus: false)
                bat(script: "copy /Y \"${WORKSPACE}\\app.js\"      \"${DEPLOY_DIR}\\app.js\"      > nul", returnStatus: false)
                bat(script: "copy /Y \"${WORKSPACE}\\styles.css\"  \"${DEPLOY_DIR}\\styles.css\"  > nul", returnStatus: false)
                echo '3 files deployed.'
            }
        }

        stage('Smoke Test') {
            steps {
                echo 'Verifying site is live...'
                bat(script: "curl -sf -o nul http://localhost:${APP_PORT}", returnStatus: false)
                echo "Site is live on http://localhost:${APP_PORT}"
            }
        }
    }

    post {
        success {
            echo 'PIPELINE PASSED - NovaCart deployed.'
        }
        failure {
            echo 'PIPELINE FAILED - check the failed stage above.'
        }
    }
}
