process.stdin.resume();
process.stdin.once("end",()=>process.stdout.write("owned-worker-ready\n"));
setInterval(()=>{},1_000);
