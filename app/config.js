// Service URLs for the browser. The defaults match docker-compose.yml.
// On AWS, Terraform overwrites this file with the load balancer URLs.
window.APP_CONFIG = {
  feedUrl: 'http://localhost:8090',
  alertsUrl: 'http://localhost:8095',
};
