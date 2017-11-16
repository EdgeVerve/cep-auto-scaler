var shell = require('shelljs');
var rp = require('request-promise');
//var loadtest = require('loadtest');
var async = require('async');
var expect = require('chai').expect;

var test_service_name = process.env.TEST_SERVICE_NAME;
var prometheus_host = process.env.PROMETHEUS_HOST;
var app_host = process.env.APP_HOST;
var NO_LOAD_INSTANCES, NO_LOAD_MEMORY, NO_LOAD_CPU, LOAD_CPU, LOAD_MEMORY, LOAD_INSTANCES, THRESHOLD_CPU_DOWN, THRESHOLD_CPU_UP, THRESHOLD_MEMORY_DOWN, THRESHOLD_MEMORY_UP, INSTANCE_UP_COUNT, INSTANCE_DOWN_COUNT
var LABEL_DOWN_COUNT, LABEL_DOWN_CPU_LIMIT, LABEL_SCALE_DOWN_MIN_COUNT, LABEL_UP_COUNT, LABEL_UP_CPU_LIMIT, LABEL_SCALE_UP_MAX_COUNT
function getCurrentInstanceCount(service) {
	var cmd = 'docker service inspect ' + service
	+ ' --format=\'{{.Spec.Mode.Replicated.Replicas}}\'';
	var result = shell.exec(cmd);
	var instanceCount = -1;
	if (result.code === 0) {
		instanceCount = Number(result);
	}
	return instanceCount;
}

function setContainerAutoscaleSpecs(service) {
	var cmd = 'docker service inspect ' + service;
	var result = shell.exec(cmd);
	var instanceCount = -1;
	if (result.code === 0) {
		 var resJson = JSON.parse(result.stdout);
		 LABEL_DOWN_COUNT = Number(resJson[0].Spec.TaskTemplate.ContainerSpec.Labels["service.autoscale.down.count"]);
		 LABEL_DOWN_CPU_LIMIT = Number(resJson[0].Spec.TaskTemplate.ContainerSpec.Labels["service.autoscale.down.cpu"]);
		 LABEL_SCALE_DOWN_MIN_COUNT = Number(resJson[0].Spec.TaskTemplate.ContainerSpec.Labels["service.autoscale.down.instances"]);
		 LABEL_UP_COUNT = Number(resJson[0].Spec.TaskTemplate.ContainerSpec.Labels["service.autoscale.up.count"]);
		 LABEL_UP_CPU_LIMIT = Number(resJson[0].Spec.TaskTemplate.ContainerSpec.Labels["service.autoscale.up.cpu"]);
		 LABEL_SCALE_UP_MAX_COUNT = Number(resJson[0].Spec.TaskTemplate.ContainerSpec.Labels["service.autoscale.up.instances"]);
	}
}

function getCurrentCPU(service) {
	return rp(cpu_service_url.replace(/@service_name@/g, service));
}

function getCurrentMemory(service) {
	return rp(memory_service_url.replace(/@service_name@/g, service));
}

function sleep(time) {
	var cmd = 'sleep ' + time;
	var result = shell.exec(cmd);
	return result
}

function setServiceConstraint(service, cpu, memory) {
	var cmd = 'docker service update ' + service + ' --limit-cpu ' + cpu
	+ ' --limit-memory ' + memory;
	var result = shell.exec(cmd);
	if (result.code !== 0) {
		console.log('docker service update failed for service:', service,
				' cpu: ', cpu, ' memory: ', memory);
		process.exit(1);
	}
	return result;
}

//Check if service name is present
if (!test_service_name) {
	console.log('Please set environment variable as TEST_SERVICE_NAME');
	process.exit(1);
}

//Check if prometheus host is present
if (!prometheus_host) {
	console.log('Please set environment variable as PROMETHEUS_HOST');
	process.exit(1);
}

var cpu_service_url = prometheus_host
+ '/api/v1/query?query=avg(rate(container_cpu_usage_seconds_total{container_label_com_docker_swarm_service_name%3D%22@service_name@%22}[1m])+%2F+IGNORING(cpu)+GROUP_LEFT(name)+(container_spec_cpu_quota{container_label_com_docker_swarm_service_name%3D%22@service_name@%22}+%2F+100000))+BY+(container_label_com_docker_swarm_service_name)+KEEP_COMMON+*+100'
var memory_service_url = prometheus_host
+ '/api/v1/query?query=avg(container_memory_usage_bytes%7Bcontainer_label_com_docker_swarm_service_name%3D%22@service_name@%22%7D)+KEEP_COMMON'

//Loading with requests
/*var loadOptions = {
		url : app_host,
		requestsPerSecond : 500,
		maxSeconds : 120
};

function load() {
	loadtest.loadTest(loadOptions, function(error, result) {
		if (error) {
			return console.error('\nGot an error:', error);
			process.exit(1);
		}
		console.log('\nLoad test done. Results:', result);
	});
}*/

function load() {
	var cmd = 'ab -r -n 15000 -c 100 ' + app_host + '/';
	var result = shell.exec(cmd);
	console.log('\nLoad test done. Results:', result);
}


describe("Running Autoscale Test cases", function () {
	this.timeout(5000000);
	before('Do Process',function (done){
		doProcess(done);
	});
	it('Running test cases',function(done){
		expect(INSTANCE_UP_COUNT).to.be.above(0);
		expect(INSTANCE_UP_COUNT % LABEL_UP_COUNT).to.equal(0);
		expect(LOAD_INSTANCES).to.be.at.most(LABEL_SCALE_UP_MAX_COUNT);
		expect(INSTANCE_DOWN_COUNT).to.be.above(0);
		expect(INSTANCE_DOWN_COUNT % LABEL_DOWN_COUNT).to.equal(0);
		expect(NO_LOAD_INSTANCES).to.be.at.least(LABEL_SCALE_DOWN_MIN_COUNT);
		done();
	});
});

function doProcess(done){
async
.series(
		{
			init : function(cb) {
				console.log('Step 0 : Populate labels');
				setContainerAutoscaleSpecs(test_service_name);
				cb();
			},
			one : function(cb) {
				console.log('Step 1 : Get instance count before load');
				NO_LOAD_INSTANCES = getCurrentInstanceCount(test_service_name);
				console.log('NO_LOAD_INSTANCES:', NO_LOAD_INSTANCES);
				cb();
			},
			two : function(cb) {
				// Get current CPU/Memory usage without load
				console.log('Step 2 : Get current CPU usage without load');
				getCurrentCPU(test_service_name)
				.then(
						function(cpuResponse) {
							console.log(cpuResponse);
							NO_LOAD_CPU = Number(JSON.parse(cpuResponse).data.result[0].value[1]);
							console.log('NO_LOAD_CPU:', NO_LOAD_CPU);
							cb();
						}, function (err){
							console.log(err);
							process.exit(1);
						});

			},
			three : function(cb) {
				console.log('Step 3 : Get current Memory usage without load');
				getCurrentMemory(test_service_name)
				.then(
						function(memoryResponse) {
							console.log(memoryResponse);
							NO_LOAD_MEMORY = Number(JSON.parse(memoryResponse).data.result[0].value[1]);
							console.log('NO_LOAD_MEMORY:',
									NO_LOAD_MEMORY);
							cb();
						}, function (err){
							console.log(err);
							process.exit(1);
						});
			},
			four : function(cb) {
				console.log("Step 4: Now under load");
				load();
				cb();
			},
			/*five : function(cb) {
				// Get current CPU usage after load
				getCurrentCPU(test_service_name)
				.then(
						function(cpuResponse) {
							console.log(cpuResponse);
							LOAD_CPU = Number(JSON
									.parse(cpuResponse).data.result[0].value[1]);
							console.log('LOAD_CPU:', LOAD_CPU);
							cb();
						});
			},
			six : function(cb) {
				// Get current Memory usage after load
				getCurrentMemory(test_service_name)
				.then(
						function(memoryResponse) {
							console.log(memoryResponse);
							LOAD_MEMORY = Number(JSON
									.parse(memoryResponse).data.result[0].value[1]);
							console.log('LOAD_MEMORY:',
									LOAD_MEMORY);
							cb();
						});
			},*/
			seven : function(cb) {
				console.log("Step 5: Instance count after load");
				LOAD_INSTANCES = getCurrentInstanceCount(test_service_name);
				console.log('LOAD_INSTANCES:', LOAD_INSTANCES);

				//THRESHOLD_CPU_DOWN = NO_LOAD_CPU + (LOAD_CPU - NO_LOAD_CPU) * 0.1; 
				//THRESHOLD_CPU_UP = NO_LOAD_CPU + (LOAD_CPU - NO_LOAD_CPU) * 0.8;

				//THRESHOLD_MEMORY_DOWN = NO_LOAD_MEMORY + (LOAD_MEMORY - NO_LOAD_MEMORY) * 0.1; 
				//THRESHOLD_MEMORY_UP = NO_LOAD_MEMORY + (LOAD_MEMORY - NO_LOAD_MEMORY) * 0.8;

				//result = setServiceConstraint(test_service_name, '0.1', LOAD_MEMORY * 1.1);
				// wait for service to be updated setTimeout(cb1, 20000);
				
				//TEST_LOAD_INSTANCES = LOAD_INSTANCES;
				//TEST_LOAD_MEMORY = LOAD_MEMORY
				//TEST_LOAD_CPU = LOAD_CPU
				
				INSTANCE_UP_COUNT = LOAD_INSTANCES - NO_LOAD_INSTANCES;
				
				if( INSTANCE_UP_COUNT === 0 || INSTANCE_DOWN_COUNT < 0 ){
					console.log('scale up did not occurred for service: ' + test_service_name);
					process.exit(1);
				}
				
				if(INSTANCE_UP_COUNT % LABEL_UP_COUNT !== 0 ){
					console.log('scale up did not occurred with correct number for service: ' + test_service_name);
					process.exit(1);
				}
				
				
				console.log('Scale up occurred for service: ' + test_service_name);
				
				console.log("Waiting for load to fall and scale down to occur at:" , new Date());
				sleep(300);
				cb();
			},
			eight : function(cb) {
				console.log("Step 6: Instance count after decreasing load");
				NO_LOAD_INSTANCES = getCurrentInstanceCount(test_service_name);
				console.log("Waiting finished at:", new Date());
				console.log('NO_LOAD_INSTANCES:', NO_LOAD_INSTANCES);
				
				INSTANCE_DOWN_COUNT = LOAD_INSTANCES - NO_LOAD_INSTANCES;
				
				
				if( INSTANCE_DOWN_COUNT === 0 || INSTANCE_DOWN_COUNT < 0 ){
					console.log('scale down did not occurred for service: ' + test_service_name);
					process.exit(1);
				}
				
				if(INSTANCE_DOWN_COUNT % LABEL_DOWN_COUNT !== 0  ){
					console.log('scale down did not occurred with correct number for service: ' + test_service_name);
					process.exit(1);
				}
			
				console.log('Scale down occurred for service: ' + test_service_name);
				cb();
			}

		},

		function(err, results) {
			if(err){
				console.log("Final Async error:", err);
				process.exit(1);
			}
			console.log(err, results);
			done();
		});
};

