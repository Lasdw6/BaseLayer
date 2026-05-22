#!/usr/bin/env bash
set -euo pipefail

LAB=/root/firecracker-lab
mkdir -p "$LAB"
cd "$LAB"

ARCH=$(uname -m)
RELEASE_URL="https://github.com/firecracker-microvm/firecracker/releases"
LATEST=$(basename "$(curl -fsSLI -o /dev/null -w '%{url_effective}' "${RELEASE_URL}/latest")")

if [ ! -x firecracker ]; then
  curl -L "${RELEASE_URL}/download/${LATEST}/firecracker-${LATEST}-${ARCH}.tgz" | tar -xz
  mv "release-${LATEST}-${ARCH}/firecracker-${LATEST}-${ARCH}" firecracker
  chmod +x firecracker
fi

CI_VERSION="${LATEST%.*}"

if ! ls vmlinux-* >/dev/null 2>&1; then
  latest_kernel_key=$(
    curl -fsSL "http://spec.ccfc.min.s3.amazonaws.com/?prefix=firecracker-ci/${CI_VERSION}/${ARCH}/vmlinux-&list-type=2" |
      grep -oP '(?<=<Key>)(firecracker-ci/[^<]+/vmlinux-[0-9]+\.[0-9]+\.[0-9]{1,3})(?=</Key>)' |
      sort -V |
      tail -1
  )
  wget -q "https://s3.amazonaws.com/spec.ccfc.min/${latest_kernel_key}"
fi

if ! ls *.ext4 >/dev/null 2>&1; then
  latest_ubuntu_key=$(
    curl -fsSL "http://spec.ccfc.min.s3.amazonaws.com/?prefix=firecracker-ci/${CI_VERSION}/${ARCH}/ubuntu-&list-type=2" |
      grep -oP '(?<=<Key>)(firecracker-ci/[^<]+/ubuntu-[0-9]+\.[0-9]+\.squashfs)(?=</Key>)' |
      sort -V |
      tail -1
  )
  ubuntu_version=$(basename "$latest_ubuntu_key" .squashfs | grep -oE '[0-9]+\.[0-9]+')
  wget -q -O "ubuntu-${ubuntu_version}.squashfs.upstream" "https://s3.amazonaws.com/spec.ccfc.min/${latest_ubuntu_key}"
  rm -rf squashfs-root
  unsquashfs -f "ubuntu-${ubuntu_version}.squashfs.upstream" >/dev/null
  ssh-keygen -f id_rsa -N "" >/dev/null
  mkdir -p squashfs-root/root/.ssh
  cp -f id_rsa.pub squashfs-root/root/.ssh/authorized_keys
  mv -f id_rsa "ubuntu-${ubuntu_version}.id_rsa"
  chown -R root:root squashfs-root
  truncate -s 1G "ubuntu-${ubuntu_version}.ext4"
  mkfs.ext4 -d squashfs-root -F "ubuntu-${ubuntu_version}.ext4" >/dev/null
fi

API_SOCKET=/tmp/firecracker.socket
TAP_DEV=tap0
TAP_IP=172.16.0.1
MASK_SHORT=/30
FC_IP=172.16.0.2
FC_MAC=06:00:AC:10:00:02
KERNEL="./$(ls vmlinux-* | tail -1)"
ROOTFS="./$(ls *.ext4 | tail -1)"
KEY_NAME="./$(ls *.id_rsa | tail -1)"

rm -f "$API_SOCKET" firecracker.log fc.stdout fc.stderr /tmp/fc-ssh.out /tmp/fc-ssh.err
ip link del "$TAP_DEV" 2>/dev/null || true
ip tuntap add dev "$TAP_DEV" mode tap
ip addr add "${TAP_IP}${MASK_SHORT}" dev "$TAP_DEV"
ip link set dev "$TAP_DEV" up
sysctl -w net.ipv4.ip_forward=1 >/dev/null
HOST_IFACE=$(ip -j route list default | jq -r '.[0].dev')
iptables -P FORWARD ACCEPT || true
iptables -t nat -D POSTROUTING -o "$HOST_IFACE" -j MASQUERADE 2>/dev/null || true
iptables -t nat -A POSTROUTING -o "$HOST_IFACE" -j MASQUERADE

./firecracker --api-sock "$API_SOCKET" --enable-pci >fc.stdout 2>fc.stderr &
FC_PID=$!

cleanup() {
  kill "$FC_PID" 2>/dev/null || true
  ip link del "$TAP_DEV" 2>/dev/null || true
  rm -f "$API_SOCKET"
}
trap cleanup EXIT

for _ in $(seq 1 50); do
  [ -S "$API_SOCKET" ] && break
  sleep 0.1
done

curl --silent --show-error --unix-socket "$API_SOCKET" -X PUT --data '{"log_path":"./firecracker.log","level":"Info","show_level":true,"show_log_origin":true}' http://localhost/logger >/dev/null
curl --silent --show-error --unix-socket "$API_SOCKET" -X PUT --data "{\"kernel_image_path\":\"${KERNEL}\",\"boot_args\":\"console=ttyS0 reboot=k panic=1 ip=172.16.0.2::172.16.0.1:255.255.255.252::eth0:off\"}" http://localhost/boot-source >/dev/null
curl --silent --show-error --unix-socket "$API_SOCKET" -X PUT --data "{\"drive_id\":\"rootfs\",\"path_on_host\":\"${ROOTFS}\",\"is_root_device\":true,\"is_read_only\":false}" http://localhost/drives/rootfs >/dev/null
curl --silent --show-error --unix-socket "$API_SOCKET" -X PUT --data "{\"iface_id\":\"net1\",\"guest_mac\":\"${FC_MAC}\",\"host_dev_name\":\"${TAP_DEV}\"}" http://localhost/network-interfaces/net1 >/dev/null

sleep 0.1
START_MS=$(date +%s%3N)
curl --silent --show-error --unix-socket "$API_SOCKET" -X PUT --data '{"action_type":"InstanceStart"}' http://localhost/actions >/dev/null

for _ in $(seq 1 60); do
  if ssh -q -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=1 -i "$KEY_NAME" root@"$FC_IP" 'echo ready' >/tmp/fc-ssh.out 2>/tmp/fc-ssh.err; then
    END_MS=$(date +%s%3N)
    printf '{"bootMs":%s}\n' "$((END_MS - START_MS))"
    exit 0
  fi
  sleep 1
done

cat /tmp/fc-ssh.err >&2 || true
cat fc.stderr >&2 || true
cat firecracker.log >&2 || true
exit 1
