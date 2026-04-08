#!/bin/bash
set -e

# Cleanup package list
apt-get clean
apt-get autoremove -y || true
rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*