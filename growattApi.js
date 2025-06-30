// growattApi.js
const Growatt = require('growatt');

const growattInstance = new Growatt({ indexCandI: true });

async function login(user, password) {
  if (!growattInstance.isConnected()) {
    await growattInstance.login(user, password);
  }
  return growattInstance; // Retorna a instância logada
}

async function getAllPlantData(growatt, options) {
  return growatt.getAllPlantData(options);
}

async function logout(growatt) {
  return growatt.logout();
}

module.exports = {
  login,
  getAllPlantData,
  logout,
};
