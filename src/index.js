var fs = require('fs')
var AWS = require('aws-sdk')
var Promise = require('es6-promise').Promise
var _ = require('lodash')

AWS.Request.prototype.promise = function() {
  return new Promise((resolve, reject) => {
    this.on('complete', function(resp) {
      if (resp.error) reject(resp.error)
      else resolve(resp.data)
    })

    this.send()
  })
}

function main(args) {
  var config = JSON.parse(fs.readFileSync('lambda.json'))

  var zipFile = args[2]
  if (!zipFile || !fs.existsSync(zipFile)) {
    console.error("usage: lambda-deploy ZIPFILE ENVIRONMENT [REGION...]")
  }

  var env = args[3]
  if (!env) {
    console.error("usage: lambda-deploy ZIPFILE ENVIRONMENT [REGION...]")
    process.exit()
  }

  var regions = args.length > 4 ? args.slice(4) : config.regions
  if (regions.length === 0) {
    console.error("usage: lambda-deploy ZIPFILE ENVIRONMENT [REGION...]")
    console.error("")
    console.error("remember to configure the default deploy regions in lambda.json")

    process.exit()
  }

  console.log("Deploying " + zipFile + " as " + config.name + " to " + env + " in regions " + regions.join(', '))
  deploy(config, zipFile, env, regions)
    .then(_ => console.log("Finished"))
    .catch(err => console.error("Unexpected error:\n" + err.stack))
}

function deploy(config, zipFile, env, regions) {
  return new Promise((resolve, reject) => {
    function loop(idx) {
      var region = regions[idx]
      if (!region) {
        resolve()
      } else {
        deployToRegion(zipFile, region, config, env)
          .then(_ => loop(idx+1))
          .catch(err => reject(err))
      }
    }

    loop(0)
  })
}

function deployToRegion(zipFile, region, config, env) {
  var s3 = new AWS.S3({ region: region })
  var s3Bucket = config.name + '-' + env + '-' + region
  var s3Key = config.name + '-' + env + '.jar'
  var s3Data = fs.createReadStream(zipFile)

  console.log("Deploying to " + region)
  return createCodeBucketOrContinue(s3, s3Bucket)
    .then(_ => uploadCodeToBucket(s3, s3Bucket, s3Key, s3Data))
    .then(_ => ensureCloudformationStackUpToDate(region, env, config, s3Bucket, s3Key))
    .then(functionName => updateLambdaFunctionCode(region, env, config, functionName, s3Bucket, s3Key))
}

function updateLambdaFunctionCode(region, env, config, functionName, s3Bucket, s3Key) {
  console.log("Updating lambda function code to: s3://" + s3Bucket + "/" + s3Key)
  var lambda = new AWS.Lambda({ region: region })

  var params = {
    FunctionName: functionName,
    S3Bucket: s3Bucket,
    S3Key: s3Key,
    Publish: true
  }

  return lambda.updateFunctionCode(params).promise()
}

function createCodeBucketOrContinue(s3, s3Bucket) {
  return s3.headBucket({ Bucket: s3Bucket }).promise().catch(_ => {
    console.log("Bucket " + s3Bucket + " does not exist. Creating it.")

    return s3.createBucket({
      Bucket: s3Bucket,
      ACL: 'private'
    }).promise()
  })
}

function uploadCodeToBucket(s3, s3Bucket, s3Key, s3Data) {
  console.log("Uploading to " + s3Bucket + "/" + s3Key)
  return s3.putObject({
    Bucket: s3Bucket,
    Key: s3Key,
    Body: s3Data
  }).promise()
}

function ensureCloudformationStackUpToDate(region, env, config, s3Bucket, s3Key) {
  var cf = new AWS.CloudFormation({ region: region })
  var stackName = config.name + '-' + region + '-' + env
  var template = JSON.stringify(config.cloudFormation)

  return cf.validateTemplate({ TemplateBody: template }).promise()
    .then(_ => createOrUpdateStack())
    .then(_ => readLambdaFunctionNameFromOutputs())

  function createOrUpdateStack() {
    return cf.describeStacks({ StackName: stackName }).promise()
      .catch(err => createCloudformationStack())
      .then(_ => updateCloudformationStack())
  }

  function updateCloudformationStack() {
    return cf.getTemplate({ StackName: stackName }).promise().then(response => {
      var deployedTemplate = response.TemplateBody
      var templateChanged = !_.isEqual(JSON.parse(template), JSON.parse(deployedTemplate))

      if (templateChanged) {
        var params = {
          StackName: stackName,
          Capabilities: ['CAPABILITY_IAM'],
          TemplateBody: template,
          Parameters: [
            { ParameterKey: "Environment", ParameterValue: env },
            { ParameterKey: "Region", ParameterValue: region },
            { ParameterKey: "S3Bucket", ParameterValue: s3Bucket },
            { ParameterKey: "S3Key", ParameterValue: s3Key }
          ]
        }

        console.log("CloudFormation template changed. Updating stack.")

        return cf.updateStack(params).promise()
          .then(_ => waitCloudformationComplete(cf, stackName, 'UPDATE_COMPLETE', ['UPDATE_ROLLBACK_FAILED', 'UPDATE_ROLLBACK_COMPLETE']))
      }
    })
  }

  function createCloudformationStack() {
    console.log("Creating CloudFormation stack " + stackName)

    var params = {
      StackName: stackName,
      TemplateBody: template,
      Capabilities: ['CAPABILITY_IAM'],
      Parameters: [
        { ParameterKey: "Environment", ParameterValue: env },
        { ParameterKey: "Region", ParameterValue: region },
        { ParameterKey: "S3Bucket", ParameterValue: s3Bucket },
        { ParameterKey: "S3Key", ParameterValue: s3Key }
      ]
    }

    return cf.createStack(params)
      .promise()
      .then(_ => waitCloudformationComplete(cf, stackName, 'CREATE_COMPLETE', ['CREATE_FAILED', 'ROLLBACK_COMPLETE']))
  }

  function readLambdaFunctionNameFromOutputs() {
    return cf.describeStacks({ StackName: stackName }).promise().then(response => {
      var outputs = response.Stacks[0].Outputs
      var output = outputs.filter(output => output.OutputKey === 'FunctionName')[0]
      return output.OutputValue
    })
  }
}


function waitCloudformationComplete(cf, stackName, successStatus, exitStatuses) {
  return new Promise((resolve, reject) => {
    function loop(eventsNextToken) {
      cf.describeStacks({ StackName: stackName }, (err, response) => {
        if (err) {
          reject(err)
        } else {
          var status = response.Stacks[0].StackStatus
          if (status === successStatus) {
            resolve()
          } else if (exitStatuses.indexOf(status) !== -1) {
            reject(new Error('CloudFormation failed: ' + response.StackStatusReason))
          } else {
            logCloudformationEvents(cf, stackName, eventsNextToken).then(nextToken => {
              setTimeout(() => loop(nextToken), 1000)
            }).catch(reject)
          }
        }
      })
    }

    loop(null)
  })
}

var loggedEventIds = {}

function logCloudformationEvents(cf, stackName, nextToken) {
  return cf.describeStackEvents({
    NextToken: nextToken,
    StackName: stackName
  }).promise().then(response => {
    response.StackEvents.forEach(e => {
      if (!loggedEventIds[e.EventId]) {
        console.log(e.Timestamp + ' - ' + e.LogicalResourceId + ' - ' + e.ResourceStatus + ' - ' + e.ResourceStatusReason)
        loggedEventIds[e.EventId] = true
      }
    })

    return response.NextToken
  })
}

main(process.argv)

