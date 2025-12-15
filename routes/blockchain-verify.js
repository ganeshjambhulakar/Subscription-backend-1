const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const { ethers } = require('ethers');
const contractService = require('../services/contractService');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * GET /api/verify/plan/:planId
 * Verify a plan ID exists on blockchain
 */
router.get('/plan/:planId', async (req, res, next) => {
  try {
    const { planId } = req.params;
    const contract = await contractService.getContract();
    
    try {
      const plan = await contract.getPlan(planId);
      res.json({
        valid: true,
        planId: planId,
        blockchain: {
          planId: plan.planId.toString(),
          vendor: plan.vendor,
          name: plan.name,
          price: plan.price.toString(),
          duration: plan.duration.toString(),
          active: plan.active
        }
      });
    } catch (error) {
      res.status(404).json({
        valid: false,
        error: 'Plan not found on blockchain'
      });
    }
  } catch (error) {
    console.error('Error verifying plan:', error);
    next(error);
  }
});

/**
 * GET /api/verify/subscription/:tokenId
 * Verify a subscription token ID exists on blockchain
 */
router.get('/subscription/:tokenId', async (req, res, next) => {
  try {
    const { tokenId } = req.params;
    const contract = await contractService.getContract();
    
    try {
      const subscription = await contract.getSubscription(tokenId);
      const isValid = await contract.isSubscriptionValid(tokenId);
      
      res.json({
        valid: true,
        tokenId: tokenId,
        blockchain: {
          tokenId: subscription.tokenId.toString(),
          planId: subscription.planId.toString(),
          subscriber: subscription.subscriber,
          startTime: subscription.startTime.toString(),
          endTime: subscription.endTime.toString(),
          active: subscription.active,
          isValid: isValid
        }
      });
    } catch (error) {
      res.status(404).json({
        valid: false,
        error: 'Subscription not found on blockchain'
      });
    }
  } catch (error) {
    console.error('Error verifying subscription:', error);
    next(error);
  }
});

/**
 * GET /api/verify/vendor/:vendorAddress
 * Verify a vendor address exists on blockchain
 */
router.get('/vendor/:vendorAddress', async (req, res, next) => {
  try {
    const { vendorAddress } = req.params;
    const contract = await contractService.getContract();
    
    // Verify address format
    if (!ethers.isAddress(vendorAddress)) {
      return res.status(400).json({
        valid: false,
        error: 'Invalid address format'
      });
    }
    
    // Check if vendor has plans on blockchain
    try {
      const plans = await contract.getVendorPlans(vendorAddress);
      res.json({
        valid: true,
        vendorAddress: ethers.getAddress(vendorAddress),
        blockchain: {
          totalPlans: plans.length,
          planIds: plans.map(p => p.toString())
        }
      });
    } catch (error) {
      res.json({
        valid: true,
        vendorAddress: ethers.getAddress(vendorAddress),
        blockchain: {
          totalPlans: 0,
          planIds: []
        }
      });
    }
  } catch (error) {
    console.error('Error verifying vendor:', error);
    next(error);
  }
});

/**
 * GET /api/verify/customer/:customerAddress
 * Verify a customer address exists on blockchain
 */
router.get('/customer/:customerAddress', async (req, res, next) => {
  try {
    const { customerAddress } = req.params;
    const contract = await contractService.getContract();
    
    // Verify address format
    if (!ethers.isAddress(customerAddress)) {
      return res.status(400).json({
        valid: false,
        error: 'Invalid address format'
      });
    }
    
    // Check if customer has subscriptions on blockchain
    try {
      const subscriptions = await contract.getUserSubscriptions(customerAddress);
      res.json({
        valid: true,
        customerAddress: ethers.getAddress(customerAddress),
        blockchain: {
          totalSubscriptions: subscriptions.length,
          tokenIds: subscriptions.map(t => t.toString())
        }
      });
    } catch (error) {
      res.json({
        valid: true,
        customerAddress: ethers.getAddress(customerAddress),
        blockchain: {
          totalSubscriptions: 0,
          tokenIds: []
        }
      });
    }
  } catch (error) {
    console.error('Error verifying customer:', error);
    next(error);
  }
});

/**
 * GET /api/verify/app/:appId
 * Verify an app ID exists on blockchain
 */
router.get('/app/:appId', async (req, res, next) => {
  try {
    const { appId } = req.params;
    const contract = await contractService.getContract();
    
    try {
      const app = await contract.getApp(appId);
      res.json({
        valid: true,
        appId: appId,
        blockchain: {
          appId: app.appId.toString(),
          vendor: app.vendor,
          name: app.name,
          description: app.description,
          active: app.active,
          createdAt: app.createdAt.toString()
        }
      });
    } catch (error) {
      res.status(404).json({
        valid: false,
        error: 'App not found on blockchain'
      });
    }
  } catch (error) {
    console.error('Error verifying app:', error);
    next(error);
  }
});

module.exports = router;

