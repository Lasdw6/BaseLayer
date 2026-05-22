import { createControlPlaneStore } from "../src/api/store.js";
import { runControlPlaneStoreContractSuite } from "./helpers/control-plane-store-contract.js";

runControlPlaneStoreContractSuite("ControlPlaneStore", createControlPlaneStore);
