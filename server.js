http = require('http');
fs = require('fs');
var MongoClient = require('mongodb').MongoClient;
var dbhost = process.env.DB_HOST || 'mongo';
var dbport = process.env.DB_PORT || '27017';

var url = "mongodb://" + dbhost + ":" + dbport + "/autoscaler";
var shell = require('shelljs');

var validAlerts = process.env.VALID_ALERTS ? process.env.VALID_ALERTS.split(',') : "MemoryUpAlert,MemoryDownAlert,CPUUpAlert,CPUDownAlert".split(',');

function getCurrentInstanceCount(service)
{
    var cmd = 'docker service inspect ' + service;
    var result = shell.exec(cmd);
    var instanceCount = -1;
    if(result.code === 0)
    {
        var resJson = JSON.parse(result.stdout);
        instanceCount = Number(resJson[0].Spec.Mode.Replicated.Replicas);
    }
    console.log("getCurrentInstanceCount: " + service + " has " + instanceCount + " instances currently (before scaling)" );
    return instanceCount;
}

function scale(service, instanceCount)
{
    var cmd = 'docker service scale ' + service + '=' + instanceCount;
    console.log("cmd:", cmd);
    var result = shell.exec(cmd);
    console.log('scale: Scaling ' + service + ' to ' + instanceCount + ' instances. Result: ' + result.code);
    return result.code;
}



server = http.createServer( function(req, res) {
    if (req.method == 'POST') {
        var body = '';
        req.on('data', function (data) {
            body += data;
        });
        req.on('end', function () {
            var fixedJSON = body

        // Replace ":" with "@colon@" if it's between double-quotes
        .replace(/:\s*"([^"]*)"/g, function(match, p1) {
                return ': "' + p1.replace(/:/g, '@colon@') + '"';
        })

        // Replace ":" with "@colon@" if it's between single-quotes
        .replace(/:\s*'([^']*)'/g, function(match, p1) {
                return ': "' + p1.replace(/:/g, '@colon@') + '"';
        })

        // Add double-quotes around any tokens before the remaining ":"
        .replace(/(['"])?([a-z0-9A-Z_]+)(['"])?\s*:/g, '"$2": ')

        // Turn "@colon@" back into ":"
        .replace(/@colon@/g, ':')
;
            var alerts = JSON.parse(fixedJSON).alerts;
            alerts.forEach(function(alert) {

                var status = alert.status;
                var alertname = alert.labels.alertname;

                if(validAlerts.indexOf(alertname) < 0  || status !== 'firing' ) {
                   res.writeHead(200, {'Content-Type': 'text/html'});
                   res.end('ignoring alert: ' + alertname);
                   return;
                }


                MongoClient.connect(url, function(err, db) {
                    if (err) throw err;
                    db.collection("alerts").insertOne(alert, function(err, res) {
                        if (err) throw err;
                        console.log("1 record inserted");
                        db.close();
                    });
                });


                var stack =                     alert.labels.container_label_com_docker_stack_namespace;
                var service =                   alert.labels.container_label_com_docker_swarm_service_name;
                var scaleUpStep =               Number(alert.labels.container_label_service_autoscale_up_count);
                var scaleDownStep =             Number(alert.labels.container_label_service_autoscale_down_count);
                var minAllowedMemory =          Number(alert.labels.container_label_service_autoscale_down_memory);
                var minAllowedCPU =             Number(alert.labels.container_label_service_autoscale_down_cpu);
                var maxAllowedMemory =          Number(alert.labels.container_label_service_autoscale_up_memory);
                var maxAllowedCPU =             Number(alert.labels.container_label_service_autoscale_up_cpu);
                var maxAllowedInstanceCount =   1;
                var minAllowedInstanceCount =   1;

                if(alert.labels.container_label_service_autoscale_up_instances !== undefined)
                    maxAllowedInstanceCount =   Number(alert.labels.container_label_service_autoscale_up_instances);

                if(alert.labels.container_label_service_autoscale_down_instances !== undefined)
                    minAllowedInstanceCount =   Number(alert.labels.container_label_service_autoscale_down_instances);

                var currentValue  =             0;
                if(alert.annotations && alert.annotations.value !== undefined)
                    currentValue  =             Number(alert.annotations.value);

                var currentMemory = 0;
                var currentCPU = 0;

                if(alertname === 'MemoryUpAlert' || alertname === 'MemoryDownAlert')
                    currentMemory = currentValue;

                if(alertname === 'CPUUpAlert' || alertname === 'CPUDownAlert')
                    currentCPU = currentValue;


                var date = new Date();

                var currentInstanceCount =      getCurrentInstanceCount(service);

                console.log("\n\n\n", '\ndate:',date, '\nstatus:', status, '\nalertname:', alertname, '\nservice:', service,
                                  '\nscaleUpStep:', scaleUpStep, '\nscaleDownStep:', scaleDownStep,
                                  '\ncurrentMemory:', currentMemory, '\nmaxAllowedMemory:', maxAllowedMemory,
                                  '\nminAllowedMemory:', minAllowedMemory, '\nmaxAllowedInstanceCount:', maxAllowedInstanceCount,
                                  '\nminAllowedInstanceCount:', minAllowedInstanceCount, '\nmaxAllowedCPU', maxAllowedCPU,
                                  '\nminAllowedCPU', minAllowedCPU, "\nvalue", currentValue, "\ncurrentCPU", currentCPU);

               console.log("\n(currentInstanceCount + scaleUpStep <= maxAllowedInstanceCount):", (currentInstanceCount + scaleUpStep <= maxAllowedInstanceCount));
               console.log("\n(currentInstanceCount >= scaleDownStep + minAllowedInstanceCount):", (currentInstanceCount >= scaleDownStep + minAllowedInstanceCount));
               console.log("\nalertname:", alertname, "\ncurrentInstanceCount", currentInstanceCount);


                if((alertname === 'MemoryUpAlert') && (currentInstanceCount + scaleUpStep <= maxAllowedInstanceCount) && (currentMemory > maxAllowedMemory))
                    scale(service, currentInstanceCount + scaleUpStep);

                if((alertname === 'MemoryDownAlert') && (currentInstanceCount >= scaleDownStep + minAllowedInstanceCount) && (currentMemory < minAllowedMemory))
                    scale(service, currentInstanceCount - scaleDownStep);

                if((alertname === 'CPUUpAlert') && (currentInstanceCount + scaleUpStep <= maxAllowedInstanceCount) && (currentCPU > maxAllowedCPU))
                    scale(service, currentInstanceCount + scaleUpStep);

                if((alertname === 'CPUDownAlert') && (currentInstanceCount >= scaleDownStep + minAllowedInstanceCount) && (currentCPU < minAllowedCPU))
                    scale(service, currentInstanceCount - scaleDownStep);

            });

        });
        res.writeHead(200, {'Content-Type': 'text/html'});
        res.end('post received');
    }
});

port = 8081;
host = '0.0.0.0';
server.listen(port, host);
console.log('version:', 8, ':  Listening at http://' + host + ':' + port);
