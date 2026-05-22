# Security Policy

BaseLayer is a research/runtime project for browser hosting infrastructure. Do
not expose a control-plane or node-agent listener to the public internet without
authentication, network filtering, and operational review.

Security-sensitive defaults to review before deployment:

- `CONTROL_PLANE_PUBLIC_V1_ONLY`
- `CONTROL_PLANE_ENFORCE_PROVIDER_API_KEY_AUTH`
- `CONTROL_PLANE_PROVIDER_API_KEY_CONFIG_PATH`
- `CONTROL_PLANE_EXPOSE_INTERNAL_ROUTES`
- `CONTROL_PLANE_EXPOSE_DASHBOARD_ROUTES`
- node-agent bind hosts and public URLs

Please report vulnerabilities privately to the repository owner before opening
public issues with exploit details.
