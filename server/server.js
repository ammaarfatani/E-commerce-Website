import express from 'express';
import pg from 'pg';
import cors from 'cors';
import dotenv from 'dotenv';
import bcrypt from 'bcrypt';
import cookieParser from 'cookie-parser';
import Stripe from "stripe";
import paypal from '@paypal/checkout-server-sdk';


dotenv.config();

const saltRounds = 10;
const app = express();
app.use(express.json());
app.use(cors());

// PostgreSQL database connectionimport Stripe from "stripe";
const stripe = new Stripe(process.env.STRIPE_SECRET);

const db = new pg.Client({
  user: process.env.PG_USER,
  host: process.env.PG_HOST,
  database: process.env.PG_DATABASE,
  password: process.env.PG_PASSWORD,
  port: process.env.PG_PORT,
});

db.connect();

// Fetch all products or filter by category
app.get('/suitsProducts', async (req, res) => {
  try {
    const category = req.query.category;

    let query = 'SELECT * FROM products';
    let params = [];

    if (category) {
      query += ' WHERE category = $1';
      params.push(category);
    }

    const result = await db.query(query, params);
    const products = result.rows;
    return res.json(products);
  } catch (error) {
    console.error("Error retrieving products:", error);
    res.status(500).send("Internal Server Error");
  }
});

// Fetch a single product by ID
app.get('/suitsProducts/:id', async (req, res) => {
  try {
    const productId = req.params.id;
    const result = await db.query('SELECT * FROM products WHERE id = $1', [productId]);
    const product = result.rows[0];

    if (product) {
      return res.json(product);
    } else {
      return res.status(404).send("Product not found");
    }
  } catch (error) {
    console.error("Error retrieving product:", error);
    res.status(500).send("Internal Server Error");
  }
});

app.post('/register', async (req, res) => {
  const { name, password, email } = req.body;
  try {
    const existingUser = await db.query('SELECT * FROM login WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      return res.status(409).send('User already exists');
    }
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    const result = await db.query('INSERT INTO login (name, email, password) VALUES ($1, $2, $3) RETURNING id', [name, email, hashedPassword]);
    const userId = result.rows[0].id;
    res.json({ Status: 'Success', userId });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// Optional: Backend logout route
app.post('/logout', (req, res) => {
  // Clear user session on server if you are storing sessions
  // This is an example; you can modify it as per your session management
  res.clearCookie('userToken'); // if using cookies for session
  return res.json({ message: 'Logout successful' });
});
       
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await db.query('SELECT * FROM login WHERE email = $1', [email]);
    if (result.rows.length > 0) {
      const user = result.rows[0];
      const isMatch = await bcrypt.compare(password, user.password);
      if (isMatch) {
        // Return user details
        return res.json({
          Status: 'Success',
          user: { name: user.name, email: user.email, avatar: user.avatar || '/default-avatar.png' }
        });
      } else {
        return res.status(401).json({ Error: 'Email and password do not match' });
      }
    } else {
      return res.status(404).json({ Error: 'Email not found' });
    }
  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ Error: 'Server error' });
  }
});




app.post('/completeOrder', async (req, res) => {
  try {
    const orderDetails = req.body;

    // Loop through each product in the order
    for (const item of orderDetails) {
      const {
        product_id,
        product_name,
        product_quantity,
        product_color,
        price,
        total_price,
        customer_email,
        shipping_city,
        shipping_country,
        first_name,
        last_name,
        shipping_address,
        postal_code,
        phone_number,
        payment_method,
        billing_address
      } = item;

      // Insert each product into the orders table
      await db.query(
        `INSERT INTO orders (
          product_id, product_name, product_quantity, product_color, price, total_price,
          customer_email, shipping_city, shipping_country, first_name, last_name,
          shipping_address, postal_code, phone_number, payment_method, billing_address
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
        )`,
        [
          product_id, product_name, product_quantity, product_color, price, total_price,
          customer_email, shipping_city, shipping_country, first_name, last_name,
          shipping_address, postal_code, phone_number, payment_method, billing_address
        ]
      );
    }

    // If all inserts were successful, send a success response
    res.json({ Status: 'Success' });
  } catch (error) {
    console.error('Error saving order:', error);
    res.status(500).send('Internal Server Error');
  }
});


app.post('/create-checkout-session', async (req, res) => {
  const { products } = req.body; // Destructure the products array from the request body
const lineItems = products.map((product) => ({
  price_data: {
    currency: "usd",
    product_data: {
      name: product.name,
      images: [`http://localhost:3000/${product.img}`]  // Use the fully qualified URL
    },
    unit_amount: Math.round(product.price * 100),
  },
  quantity: product.quantity
}));


  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: lineItems,
      mode: "payment",
      success_url: "http://localhost:3000/success",
      cancel_url: "http://localhost:3000/cancel"
    });

    res.json({ id: session.id });
  } catch (error) {
    console.error("Error creating checkout session:", error);
    res.status(500).send('Internal Server Error');
  }
});

const environment = new paypal.core.SandboxEnvironment('AZdIHGyAdZ0pDdaib_OPaY_u9ARSGxVAKoRnalOpuOmTAF3giAqLdY_InkH-WyRrsux0EoLPZSh-ZJQi', 'EK5ddAiodJoz7caB2RwQXq0dXeRk3edxRSo1g7msVQnfOrEZy5xFu4KhIk8tXRrXzn6nR6UikDtYORwE');
const client = new paypal.core.PayPalHttpClient(environment);


app.post('/create-paypal-order', async (req, res) => {
  
  try {
    const { cartItems, userDetails } = req.body;

    const request = new paypal.orders.OrdersCreateRequest();
    request.prefer("return=representation");
    request.requestBody({
      intent: 'CAPTURE',
      purchase_units: [
        {
          description: "Order from Online Store",
          amount: {
            currency_code: 'USD',
            value: cartItems.reduce((total, item) => total + item.total_price, 0).toFixed(2),
          },
        },
      ],
      application_context: {
        brand_name: "Online Store",
        landing_page: "BILLING",
        user_action: "PAY_NOW",
        return_url: "http://localhost:3000/success", // Update with your front-end URL
        cancel_url: "http://localhost:3000/cancel", // Update with your front-end URL
      },
    });

    const order = await client.execute(request);
    const approvalUrl = order.result.links.find(link => link.rel === "approve").href;

    res.json({ approvalUrl });
  } catch (error) {
    console.error("PayPal order creation error:", error);
    res.status(500).send("An error occurred while creating the PayPal order");
  }
});


app.listen(8081, () => {
  console.log('Server is running on http://localhost:8081...');
});
