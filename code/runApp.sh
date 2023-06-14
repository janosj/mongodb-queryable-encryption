
# Connect to local instance (no auth)
# Requires an entry for myserver1 in local /etc/hosts file.
# Note that using localhost causes an exception.
# MDB_URI=mongodb://myserver1:27017

# Atlas Commercial
# MDB_URI=mongodb+srv://<user>:<password>@your-atlas-cluster.mongodb.net/DEMO?retryWrites=true&w=majority

# Kubernetes Example
# MDB_URI=mongodb://mdb-rs-0.devsecops.mongodb.svc.cluster.local:27017,mdb-rs-1.devsecops.mongodb.svc.cluster.local:27017,mdb-rs-2.devsecops.mongodb.svc.cluster.local:27017/?replicaSet=mdb-rs;

URI=$MDB_URI node index.js

