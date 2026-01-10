import http from 'http';

const PORT = process.env.PORT || 3001;

const server = http.createServer((req, res) => {


    
    if (req.method === 'POST' && req.url === '/submitTask') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Task submitted successfully' }));
        return;
    }

    else if (req.method === 'POST' && req.url === '/cancelTask') {

            res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Task cancelled successfully' }));
        return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});

export default server;
