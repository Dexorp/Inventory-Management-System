/*
Create the code for this file. Set up a nodejs server with the following routes
- GET /readData - calls function from imported module 'db'(put comment "remember, reads header of request from client")
- POST /workAction - receives actions pretaining to workorders
- POST /createWorkorder -creates a new workorder in the database
- PUT /addworker -adds a worker to company
- PUT /updateData - updates data in the database

Add a function that runs with every request to log the request method and URL and
check the permission level of the user making the request. If the request does not have
the header value 'permission-level' return 400 Bad Request.
each route will call a function from an imported module with the same name as the route.

Before anything else runs, call a imported function 'apiPrestart' from module 'api-prestart.ts'.
wrap the call to 'apiPrestart' in a try catch block and log any errors that occur.
 */ 