import http from 'http';

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {


	
	if (req.method === 'GET' && req.url === '/getData') {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ message: 'Test Return' }));
		return;
	}

	else if (req.method === 'POST' && req.url === '/updateData') {

			res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ message: 'Update successful' }));
		return;
	}

	res.writeHead(404, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
	console.log(`Server listening on port ${PORT}`);
});

export default server;
